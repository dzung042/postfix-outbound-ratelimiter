import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MaxLength,
} from 'class-validator';

export class TierDto {
  @IsString() @MaxLength(64) name!: string;
  @IsInt() @Min(0) perMin = 0;
  @IsInt() @Min(0) perHour = 0;
  @IsInt() @Min(0) perDay = 0;
  @IsInt() @Min(0) perMonth = 0;
  @IsInt() @Min(0) maxRcptMsg = 100;
  @IsBoolean() @IsOptional() enabled = true;
}

export class DomainDto {
  @IsString() @MaxLength(255) domain!: string;
  @IsOptional() @IsInt() tierId?: number | null;
  @IsOptional() @IsInt() @Min(0) perHour?: number | null;
  @IsOptional() @IsInt() @Min(0) perDay?: number | null;
  @IsBoolean() @IsOptional() enabled = true;
  @IsOptional() @IsString() @MaxLength(255) note?: string | null;
}

export class SenderDto {
  @IsString() @MaxLength(255) email!: string;
  @IsOptional() @IsString() @MaxLength(255) domain?: string;
  @IsOptional() @IsInt() tierId?: number | null;
  @IsOptional() @IsInt() @Min(0) perMin?: number | null;
  @IsOptional() @IsInt() @Min(0) perHour?: number | null;
  @IsOptional() @IsInt() @Min(0) perDay?: number | null;
  @IsOptional() @IsInt() @Min(0) perMonth?: number | null;
  @IsBoolean() @IsOptional() persist?: boolean;
  @IsOptional() @IsIn(['active', 'warmup', 'suspended']) status?: 'active' | 'warmup' | 'suspended';
}

export class SuspendDto {
  @IsOptional() @IsString() @MaxLength(255) reason?: string;
}

export class ListSendersQuery {
  @IsOptional() @IsString() search?: string;
  // A filter param, not a write: accept any string (incl. '' = no filter). The
  // controller only applies it when it matches a real status, so a blank/unknown
  // value just means "all" instead of a 400.
  @IsOptional() @IsString() status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize = 50;
}
