/* eslint-disable @typescript-eslint/require-await */
import { createKeyv } from '@keyv/redis';
import { HttpModule } from '@nestjs/axios';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
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
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: async () => {
        return {
          stores: [
            createKeyv({
              url: process.env.REDIS_URL,
              socket: {
                connectTimeout: 60000, // 60 seconds
                keepAlive: 30000, // 30 seconds
                timeout: 300000, // 5 minutes
              },
            }),
          ],
        };
      },
    }),
    HttpModule,
    ConfigModule.forRoot(),
  ],
  controllers: [AppController],
  providers: [CryptoService],
})
export class AppModule {}
