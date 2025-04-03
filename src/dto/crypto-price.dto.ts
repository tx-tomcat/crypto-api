import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class CryptoPriceDto {
  @ApiProperty({
    description: 'Cryptocurrency symbol (e.g., BTC, ETH)',
    example: 'BTC',
  })
  @IsNotEmpty()
  @IsString()
  @Matches(/^[a-zA-Z0-9-]+$/, {
    message: 'Symbol must contain only letters, numbers, and hyphens',
  })
  symbol: string;
}
