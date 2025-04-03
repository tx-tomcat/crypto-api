/* eslint-disable @typescript-eslint/require-await */
import { createKeyv } from '@keyv/redis';
import { HttpModule } from '@nestjs/axios';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from 'nestjs-prisma';
import { AppController } from './app.controller';
import { CryptoService } from './app.service';
@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: 60000,
          limit: 10,
        },
      ],
    }),
    PrismaModule.forRoot({
      isGlobal: true,
      prismaServiceOptions: {
        prismaOptions: {
          log: ['error', 'warn'],
        },
        explicitConnect: true,
      },
    }),
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: async () => {
        return {
          stores: [
            createKeyv({
              url: process.env.REDIS_URL,
              socket: {
                connectTimeout: 60000,
                keepAlive: 30000,
                timeout: 300000,
              },
            }),
          ],
        };
      },
    }),
    ScheduleModule.forRoot(),
    HttpModule,
    ConfigModule.forRoot(),
  ],
  controllers: [AppController],
  providers: [CryptoService],
})
export class AppModule {}
