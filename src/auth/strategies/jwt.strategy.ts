import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserService } from '../../users/user.service';
import { JWT_TOKEN_USE } from '../constants';
import { JwtPayload } from '../auth.types';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private userService: UserService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    if (payload.tokenUse === JWT_TOKEN_USE.REFRESH) {
      throw new UnauthorizedException();
    }

    const user = await this.userService.findById(payload.sub);

    if (!user) {
      throw new UnauthorizedException();
    }

    const { password: _, ...safe } = user as Record<string, unknown> & { password?: string };

    return {
      ...safe,
      jti: payload.jti,
      tokenUse: payload.tokenUse ?? JWT_TOKEN_USE.ACCESS,
    };
  }
}
