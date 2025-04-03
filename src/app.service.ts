/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { HttpService } from '@nestjs/axios';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cache } from 'cache-manager';
import { catchError, firstValueFrom } from 'rxjs';
import { CryptoPrice } from './interfaces/crypto-price.interface';

@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly CACHE_KEY_TOP_100 = 'top_100_cryptos';
  private readonly CACHE_TTL = 60 * 1000;

  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  async getCryptoPrice(symbol: string): Promise<CryptoPrice> {
    // Normalize symbol to uppercase
    const normalizedSymbol = symbol.toUpperCase();

    // Check if the crypto is in our cached top 100 list
    const isInTop100 = await this.isInTop100(normalizedSymbol);
    if (!isInTop100) {
      throw new BadRequestException(
        `Cryptocurrency ${normalizedSymbol} is not in the top 100`,
      );
    }

    // Try to get from cache first
    const cacheKey = `crypto_price_${normalizedSymbol}`;
    const cachedData = await this.cacheManager.get<CryptoPrice>(cacheKey);

    if (cachedData) {
      this.logger.debug(`Cache hit for ${normalizedSymbol}`);
      return cachedData;
    }

    this.logger.debug(`Cache miss for ${normalizedSymbol}, fetching from API`);

    const apiKey = this.configService.get<string>('COINGECKO_API_KEY');
    const url = `https://api.coingecko.com/api/v3/coins/markets`;

    try {
      const { data } = await firstValueFrom(
        this.httpService
          .get(url, {
            params: {
              vs_currency: 'usd',
              ids: await this.getIdFromSymbol(normalizedSymbol),
              order: 'market_cap_desc',
              per_page: 1,
              page: 1,
              sparkline: false,
              price_change_percentage: '24h',
              x_cg_demo_api_key: apiKey, // Free tier uses this header
            },
          })
          .pipe(
            catchError((error) => {
              this.logger.error(
                `Error fetching data: ${error.message}`,
                error.stack,
              );
              throw new InternalServerErrorException(
                'Failed to fetch cryptocurrency data',
              );
            }),
          ),
      );

      if (!data || data.length === 0) {
        throw new NotFoundException(
          `Cryptocurrency ${normalizedSymbol} not found`,
        );
      }

      const cryptoData: CryptoPrice = {
        symbol: data[0].symbol.toUpperCase(),
        name: data[0].name,
        price: data[0].current_price,
        change24h: data[0].price_change_percentage_24h,
        marketCap: data[0].market_cap,
        lastUpdated: data[0].last_updated,
      };

      // Cache the result
      await this.cacheManager.set(cacheKey, cryptoData, this.CACHE_TTL);

      return cryptoData;
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      this.logger.error(
        `Failed to get price for ${normalizedSymbol}: ${error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException(
        'Failed to fetch cryptocurrency data',
      );
    }
  }

  // Helper method to check if a symbol is in top 100
  private async isInTop100(symbol: string): Promise<boolean> {
    const top100 = await this.getTop100Cryptos();
    return top100.some((crypto) => crypto.symbol.toUpperCase() === symbol);
  }

  // Helper method to get coin ID from symbol
  private async getIdFromSymbol(symbol: string): Promise<string> {
    const top100 = await this.getTop100Cryptos();
    const crypto = top100.find((c) => c.symbol.toUpperCase() === symbol);

    if (!crypto) {
      throw new NotFoundException(
        `Cryptocurrency ${symbol} not found in top 100`,
      );
    }

    return crypto.id;
  }

  // Get top 100 cryptos (cached)
  private async getTop100Cryptos(): Promise<any[]> {
    // Try to get from cache first
    const cachedData = await this.cacheManager.get<any[]>(
      this.CACHE_KEY_TOP_100,
    );

    if (cachedData) {
      return cachedData;
    }

    const apiKey = this.configService.get<string>('COINGECKO_API_KEY');
    const url = 'https://api.coingecko.com/api/v3/coins/markets';

    try {
      const { data } = await firstValueFrom(
        this.httpService
          .get(url, {
            params: {
              vs_currency: 'usd',
              order: 'market_cap_desc',
              per_page: 100,
              page: 1,
              sparkline: false,
              x_cg_demo_api_key: apiKey,
            },
          })
          .pipe(
            catchError((error) => {
              this.logger.error(
                `Error fetching top 100: ${error.message}`,
                error.stack,
              );
              throw new InternalServerErrorException(
                'Failed to fetch top 100 cryptocurrencies',
              );
            }),
          ),
      );

      // Cache the result
      await this.cacheManager.set(this.CACHE_KEY_TOP_100, data, 300 * 1000); // Cache for 5 minutes

      return data;
    } catch (error) {
      this.logger.error(
        `Failed to get top 100 cryptos: ${error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException(
        'Failed to fetch top 100 cryptocurrencies',
      );
    }
  }
}
