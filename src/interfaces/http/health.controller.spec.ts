import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('returns an ok status', () => {
    const controller = new HealthController();

    expect(controller.getStatus()).toEqual({ status: 'ok' });
  });
});
