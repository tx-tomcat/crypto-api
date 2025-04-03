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
import { Cron, CronExpression } from '@nestjs/schedule';
import { Cache } from 'cache-manager';
import { PrismaService } from 'nestjs-prisma';
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
    private prisma: PrismaService,
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

    const cryptoEntity = await this.prisma.cryptoCurrency.findUnique({
      where: { symbol: normalizedSymbol },
      include: {
        priceHistory: {
          orderBy: { timestamp: 'desc' },
          take: 1,
        },
      },
    });

    if (
      cryptoEntity?.priceHistory?.length &&
      cryptoEntity.priceHistory.length > 0
    ) {
      const latestPrice = cryptoEntity.priceHistory[0];
      const priceAge = Date.now() - latestPrice.timestamp.getTime();

      // If price is recent (less than 30 minutes old), use it
      if (priceAge < 30 * 60 * 1000) {
        const cryptoData: CryptoPrice = {
          symbol: cryptoEntity.symbol,
          name: cryptoEntity.name,
          price: latestPrice.price,
          change24h: latestPrice.change24h || 0,
          marketCap: latestPrice.marketCap || 0,
          lastUpdated: latestPrice.timestamp.toISOString(),
        };

        // Cache the result
        await this.cacheManager.set(cacheKey, cryptoData, this.CACHE_TTL);
        return cryptoData;
      }
    }

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
              x_cg_demo_api_key: apiKey,
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

      if (cryptoEntity) {
        await this.prisma.priceHistory.create({
          data: {
            cryptoId: cryptoEntity.id,
            price: data[0].current_price || 0,
            marketCap: data[0].market_cap || 0,
            volume24h: data[0].total_volume || 0,
            change24h: data[0].price_change_percentage_24h || 0,
          },
        });
      } else {
        // Create crypto and price history if it doesn't exist yet
        await this.prisma.cryptoCurrency.create({
          data: {
            symbol: data[0].symbol.toUpperCase(),
            name: data[0].name,
            slug: data[0].id,
            priceHistory: {
              create: {
                price: data[0].current_price || 0,
                marketCap: data[0].market_cap || 0,
                volume24h: data[0].total_volume || 0,
                change24h: data[0].price_change_percentage_24h || 0,
              },
            },
          },
        });
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

  private async isInTop100(symbol: string): Promise<boolean> {
    const top100 = await this.getTop100Cryptos();
    return top100.some((crypto) => crypto.symbol.toUpperCase() === symbol);
  }

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

  @Cron(CronExpression.EVERY_30_MINUTES, {
    name: 'fetchCryptoPrices',
  })
  async fetchCryptoPrices() {
    this.logger.log(
      'Starting scheduled task: Fetching latest crypto prices...',
    );
    try {
      // Fetch top 100 cryptocurrencies
      const cryptoData = await this.fetchTop100Cryptos();
      await this.saveToDatabase(cryptoData);
      this.logger.log(
        `Successfully updated prices for ${cryptoData.length} cryptocurrencies`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to fetch crypto prices: ${error.message}`,
        error.stack,
      );
    }
  }

  private async fetchTop100Cryptos(): Promise<any[]> {
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
              price_change_percentage: '24h',
              x_cg_demo_api_key: apiKey,
            },
          })
          .pipe(
            catchError((error) => {
              this.logger.error(
                `Error fetching top 100: ${error.message}`,
                error.stack,
              );
              throw new Error('Failed to fetch top 100 cryptocurrencies');
            }),
          ),
      );

      return data;
    } catch (error) {
      this.logger.error(
        `Failed to get top 100 cryptos: ${error.message}`,
        error.stack,
      );
      throw new Error('Failed to fetch top 100 cryptocurrencies');
    }
  }

  private async saveToDatabase(cryptoData: any[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const crypto of cryptoData) {
        const existingCrypto = await tx.cryptoCurrency.upsert({
          where: { symbol: crypto.symbol.toUpperCase() },
          update: {
            name: crypto.name,
            slug: crypto.id,
            updatedAt: new Date(),
          },
          create: {
            symbol: crypto.symbol.toUpperCase(),
            name: crypto.name,
            slug: crypto.id,
          },
        });

        await tx.priceHistory.create({
          data: {
            cryptoId: existingCrypto.id,
            price: crypto.current_price || 0,
            marketCap: crypto.market_cap || 0,
            volume24h: crypto.total_volume || 0,
            change24h: crypto.price_change_percentage_24h || 0,
          },
        });
      }
    });
  }
}
