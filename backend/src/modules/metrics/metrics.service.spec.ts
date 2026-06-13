import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  it('exposes the Prometheus content type', () => {
    expect(metrics.contentType).toContain('text/plain');
  });

  it('records a counter sample and a latency observation under its labels', async () => {
    metrics.observe('GET', '/api/marketing/leads', 200, 0.042);

    const out = await metrics.scrape();
    expect(out).toContain(
      'http_requests_total{method="GET",route="/api/marketing/leads",status="200"} 1',
    );
    // 42ms falls in the (0.025, 0.05] bucket, so le="0.05" is the first to count it.
    expect(out).toContain(
      'http_request_duration_seconds_bucket{le="0.05",method="GET",route="/api/marketing/leads",status="200"} 1',
    );
  });

  it('accumulates repeated calls into the same series', async () => {
    metrics.observe('GET', '/api/marketing/leads', 200, 0.01);
    metrics.observe('GET', '/api/marketing/leads', 200, 0.01);

    const out = await metrics.scrape();
    expect(out).toContain(
      'http_requests_total{method="GET",route="/api/marketing/leads",status="200"} 2',
    );
  });

  it('keeps registries isolated per instance (no global-state bleed)', async () => {
    metrics.observe('GET', '/a', 200, 0.01);
    const fresh = new MetricsService();
    const out = await fresh.scrape();
    expect(out).not.toContain('route="/a"');
  });
});
