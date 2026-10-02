import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  getStatus(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
