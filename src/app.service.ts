/* eslint-disable @typescript-eslint/no-unsafe-return */

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

    const apiKey = this.configService.get<string>('COINMARKETCAP_API_KEY');
    const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest`;

    try {
      const { data } = await firstValueFrom(
        this.httpService
          .get(url, {
            headers: {
              'X-CMC_PRO_API_KEY': apiKey || '',
            },
            params: {
              symbol: normalizedSymbol,
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

      if (!data || !data.data || !data.data[normalizedSymbol]) {
        throw new NotFoundException(
          `Cryptocurrency ${normalizedSymbol} not found`,
        );
      }

      const coinData = data.data[normalizedSymbol];
      const quote = coinData.quote.USD;

      if (cryptoEntity) {
        await this.prisma.priceHistory.create({
          data: {
            cryptoId: cryptoEntity.id,
            price: quote.price || 0,
            marketCap: quote.market_cap || 0,
            volume24h: quote.volume_24h || 0,
            change24h: quote.percent_change_24h || 0,
          },
        });
      } else {
        await this.prisma.cryptoCurrency.create({
          data: {
            symbol: coinData.symbol,
            name: coinData.name,
            slug: coinData.slug,
            priceHistory: {
              create: {
                price: quote.price || 0,
                marketCap: quote.market_cap || 0,
                volume24h: quote.volume_24h || 0,
                change24h: quote.percent_change_24h || 0,
              },
            },
          },
        });
      }

      const cryptoData: CryptoPrice = {
        symbol: coinData.symbol,
        name: coinData.name,
        price: quote.price,
        change24h: quote.percent_change_24h,
        marketCap: quote.market_cap,
        lastUpdated: quote.last_updated,
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
    return top100.some((crypto) => crypto.symbol === symbol);
  }

  // Get top 100 cryptos (cached)
  private async getTop100Cryptos(): Promise<any[]> {
    const cachedData = await this.cacheManager.get<any[]>(
      this.CACHE_KEY_TOP_100,
    );

    if (cachedData) {
      return cachedData;
    }

    const apiKey = this.configService.get<string>('COINMARKETCAP_API_KEY');
    const url =
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest';

    try {
      const { data } = await firstValueFrom(
        this.httpService
          .get(url, {
            headers: {
              'X-CMC_PRO_API_KEY': apiKey || '',
            },
            params: {
              limit: 100,
              convert: 'USD',
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

      if (!data || !data.data) {
        throw new InternalServerErrorException(
          'Failed to fetch top 100 cryptocurrencies: Invalid response format',
        );
      }

      // Cache the result
      await this.cacheManager.set(
        this.CACHE_KEY_TOP_100,
        data.data,
        300 * 1000,
      ); // Cache for 5 minutes

      return data.data;
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
    const apiKey = this.configService.get<string>('COINMARKETCAP_API_KEY');
    const url =
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest';

    try {
      const { data } = await firstValueFrom(
        this.httpService
          .get(url, {
            headers: {
              'X-CMC_PRO_API_KEY': apiKey || '',
            },
            params: {
              limit: 100,
              convert: 'USD',
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

      if (!data || !data.data) {
        throw new Error(
          'Failed to fetch top 100 cryptocurrencies: Invalid response format',
        );
      }

      return data.data;
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
        const quote = crypto.quote.USD;

        const existingCrypto = await tx.cryptoCurrency.upsert({
          where: { symbol: crypto.symbol },
          update: {
            name: crypto.name,
            slug: crypto.slug,
            updatedAt: new Date(),
          },
          create: {
            symbol: crypto.symbol,
            name: crypto.name,
            slug: crypto.slug,
          },
        });

        await tx.priceHistory.create({
          data: {
            cryptoId: existingCrypto.id,
            price: quote.price || 0,
            marketCap: quote.market_cap || 0,
            volume24h: quote.volume_24h || 0,
            change24h: quote.percent_change_24h || 0,
          },
        });
      }
    });
  }
}
