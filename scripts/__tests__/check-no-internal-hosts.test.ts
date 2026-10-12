import { ALLOWED_HOSTS, findInternalHosts } from '../check-no-internal-hosts';

/** Built, not spelled, so this file passes the check it tests. */
const on = (sub: string): string => `${sub}.bugsee.com`;

describe('findInternalHosts', () => {
  it.each(ALLOWED_HOSTS.map(host => [host]))('allows %s in any spelling', host => {
    expect(findInternalHosts(`https://${host}/v2 and ${host.toUpperCase()}:443`)).toEqual([]);
  });

  it.each([['staging'], ['apidev'], ['xapi'], ['my-api'], ['a.b']])('flags %s.bugsee.com with its line', sub => {
    expect(findInternalHosts(`ok\nurl: https://${sub}.bugsee.com/x`)).toEqual([{ line: 2, host: `${sub}.bugsee.com` }]);
  });

  it('reports every finding, per line', () => {
    expect(findInternalHosts(`${on('a')} ${on('b')}\r\n${on('c')}`)).toEqual([
      { line: 1, host: on('a') },
      { line: 1, host: on('b') },
      { line: 2, host: on('c') },
    ]);
  });

  it('is not fooled by a prefixed or percent-free lookalike', () => {
    expect(findInternalHosts('https://staging.bugsee.invalid https://bugsee.company.example')).toEqual([]);
    expect(findInternalHosts(`https://${on('dev')}.evil.example`)).toEqual([{ line: 1, host: on('dev') }]);
  });

  it('honours a custom allowlist', () => {
    expect(findInternalHosts(on('x'), [on('x')])).toEqual([]);
  });
});
