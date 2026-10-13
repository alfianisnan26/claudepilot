import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceLabel } from './devices.js';

test('device labels come from the table, never from the header', () => {
  const cases: [string, string][] = [
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 'Chrome on Linux'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0', 'Edge on Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Safari on macOS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari on iPhone'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.0.0 Mobile/15E148 Safari/604.1', 'Chrome on iPhone'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36', 'Chrome on Android'],
    ['Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Firefox on Linux'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 'Chrome on ChromeOS'],
    ['curl/8.5.0', 'curl'],
    ['node', 'Node'],
    ['', 'Unknown device'],
    ['<script>alert(1)</script> Chrome/1 Linux', 'Chrome on Linux'],
    ['SomethingNew/1.0 (Windows)', 'Browser on Windows'],
    ['SomethingNew/1.0', 'Unknown device'],
  ];
  for (const [ua, label] of cases) assert.equal(deviceLabel(ua), label, ua);
  assert.equal(deviceLabel(undefined), 'Unknown device');
  assert.ok(deviceLabel('x'.repeat(10_000)).length <= 40);
});
