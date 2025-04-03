import { CacheInterceptor } from '@nestjs/cache-manager';
import { Controller, Get, Param, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CryptoService } from './app.service';
import { CryptoPriceDto } from './dto/crypto-price.dto';

@Controller()
export class AppController {
  constructor(private readonly cryptoService: CryptoService) {}

  @ApiTags('crypto')
  @UseInterceptors(CacheInterceptor)
  @Get('price/:symbol')
  @ApiOperation({ summary: 'Get current price for a cryptocurrency by symbol' })
  @ApiResponse({ status: 200, description: 'Returns current price data' })
  @ApiResponse({ status: 400, description: 'Invalid symbol or not in top 100' })
  @ApiResponse({ status: 404, description: 'Cryptocurrency not found' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  @ApiResponse({ status: 500, description: 'Server error' })
  @ApiParam({
    name: 'symbol',
    description: 'Cryptocurrency symbol (e.g., BTC)',
  })
  async getCryptoPrice(
    @Param() params: CryptoPriceDto,
  ): Promise<CryptoPriceDto> {
    return this.cryptoService.getCryptoPrice(params.symbol);
  }
}
