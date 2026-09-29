import {
  IOS_DEVICE_ALLOWLIST,
  checkIosDeviceIdentity,
  parseIosTarget,
  requireVerifiedIosDevice,
  resolveIosDeviceId,
} from '../../examples/bare/e2e/device';
import { DeviceConsole, IosConsole, SimulatorConsole } from '../../examples/bare/e2e/scenario';

/**
 * The iOS e2e wipes the app's data container and kills its process on the
 * iPhone it drives, so which iPhone it drives fails closed (Task 3.H): an
 * allowlist only code can widen, one device refused outright, the target
 * stated exactly, and the device's identity checked before any command.
 */
const XS = '345BA7FE-2C29-5722-892A-BFCB1FD34D0C';
const XS_UDID = '00008020-000554DC2641002E';
const SIXTEEN_PRO = 'D027034D-1283-5BCB-95EF-7C048F2D4993';

describe('E2E_IOS_TARGET', () => {
  it('accepts exactly simulator or device', () => {
    expect(parseIosTarget('simulator')).toBe('simulator');
    expect(parseIosTarget('device')).toBe('device');
  });

  it.each([undefined, '', 'simulater', 'Simulator', 'DEVICE', ' device', 'iphone'])(
    'throws on %p rather than choosing hardware',
    raw => {
      expect(() => parseIosTarget(raw)).toThrow(/E2E_IOS_TARGET must be "simulator" or "device"/);
    },
  );
});

describe('IOS_DEVICE_ID', () => {
  it('defaults to the XS, the one allowlisted iPhone', () => {
    expect(Object.keys(IOS_DEVICE_ALLOWLIST)).toEqual([XS]);
    expect(resolveIosDeviceId(undefined)).toBe(XS);
    expect(resolveIosDeviceId(XS.toLowerCase())).toBe(XS);
  });

  it('refuses any id that is not allowlisted', () => {
    expect(() => resolveIosDeviceId('F418DCF1-CF85-5788-BE9B-2C582C24A13A')).toThrow(/not on the e2e allowlist/);
    expect(() => resolveIosDeviceId('')).toThrow(/not on the e2e allowlist/);
    expect(() => resolveIosDeviceId('booted')).toThrow(/not on the e2e allowlist/);
  });

  it('refuses the iPhone 16 Pro outright, by prefix', () => {
    expect(() => resolveIosDeviceId(SIXTEEN_PRO)).toThrow(/refused outright/);
    expect(() => resolveIosDeviceId('d027034d')).toThrow(/refused outright/);
  });
});

describe('the iPhone identity check', () => {
  const listed = (productType: string, udid: string, identifier = XS) => ({
    devices: [
      { identifier: SIXTEEN_PRO, hardwareProperties: { productType: 'iPhone17,1', udid: '00008140-0014382A0CD8801C' } },
      { identifier, hardwareProperties: { productType, udid } },
    ],
  });

  it('passes the XS listed as an iPhone11,2 with its UDID', () => {
    expect(() => checkIosDeviceIdentity(listed('iPhone11,2', XS_UDID), XS)).not.toThrow();
  });

  it('throws when the XS is not listed', () => {
    expect(() => checkIosDeviceIdentity({ devices: [] }, XS)).toThrow(/0 device\(s\) with id/);
    expect(() => checkIosDeviceIdentity({}, XS)).toThrow(/0 device\(s\) with id/);
  });

  it('throws when the id answers as another model or UDID', () => {
    expect(() => checkIosDeviceIdentity(listed('iPhone17,1', XS_UDID), XS)).toThrow(/not the allowlisted iPhone11,2/);
    expect(() => checkIosDeviceIdentity(listed('iPhone11,2', '00008140-0014382A0CD8801C'), XS)).toThrow(
      /not the allowlisted/,
    );
  });

  it('throws for an id that is not allowlisted, whatever is listed', () => {
    expect(() => checkIosDeviceIdentity(listed('iPhone17,1', 'x', SIXTEEN_PRO), SIXTEEN_PRO)).toThrow(
      /not on the e2e allowlist/,
    );
  });

  it('refuses a synchronous launch before the identity check has run', () => {
    const saved = process.env.IOS_DEVICE_ID;
    delete process.env.IOS_DEVICE_ID;
    try {
      expect(() => requireVerifiedIosDevice()).toThrow(/has not been verified/);
    } finally {
      if (saved !== undefined) {
        process.env.IOS_DEVICE_ID = saved;
      }
    }
  });
});

describe('IosConsole.start()', () => {
  const saved = process.env.E2E_IOS_TARGET;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.E2E_IOS_TARGET;
    } else {
      process.env.E2E_IOS_TARGET = saved;
    }
  });

  it('refuses an unsupported or unstated target', () => {
    for (const raw of [undefined, 'simulater', 'phone']) {
      if (raw === undefined) {
        delete process.env.E2E_IOS_TARGET;
      } else {
        process.env.E2E_IOS_TARGET = raw;
      }
      expect(() => IosConsole.start()).toThrow(/E2E_IOS_TARGET must be/);
    }
  });

  it('returns the console for the stated target, spawning nothing yet', () => {
    process.env.E2E_IOS_TARGET = 'simulator';
    expect(IosConsole.start()).toBeInstanceOf(SimulatorConsole);
    process.env.E2E_IOS_TARGET = 'device';
    expect(IosConsole.start()).toBeInstanceOf(DeviceConsole);
  });
});
