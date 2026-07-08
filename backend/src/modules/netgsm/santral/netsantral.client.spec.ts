import { NetsantralClient } from './netsantral.client';

describe('NetsantralClient', () => {
  const creds = { username: '8508407303', password: 'pw' };
  let fetchMock: jest.SpyInstance;
  afterEach(() => fetchMock?.mockRestore());

  it('GETs the crmsntrl originate URL with the right query params and returns the call id', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200, text: async () => '{"status":"success","unique_id":"u-1"}',
    } as any);
    const out = await new NetsantralClient().originate({
      ...creds, customer_num: '+90 555 111 22 33', internal_num: '104', trunk: '0850 840 73 03',
    });
    expect(out).toEqual({ ok: true, callId: 'u-1' });
    const url = fetchMock.mock.calls[0][0] as string;
    const opts = fetchMock.mock.calls[0][1] as any;
    expect(opts.method).toBe('GET');
    expect(url).toContain('crmsntrl.netgsm.com.tr:9111/8508407303/originate');
    expect(url).toContain('customer_num=905551112233'); // digits only
    expect(url).toContain('internal_num=104');
    expect(url).toContain('trunk=08508407303'); // digits only
    expect(url).toContain('originate_order=if'); // rep rings first
  });

  it('returns ok:false on a provider error code', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ status: 200, text: async () => '30' } as any);
    const out = await new NetsantralClient().originate({ ...creds, customer_num: '5551112233', internal_num: '104', trunk: '8508407303' });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('30');
  });

  it('scrubs username and password from a thrown error (creds are in the query string)', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(
      new Error('boom username=8508407303 password=pw and again pw'),
    );
    const out = await new NetsantralClient().originate({ ...creds, customer_num: '5', internal_num: '104', trunk: '850' });
    expect(out.ok).toBe(false);
    expect(out.message).not.toContain('pw');
    expect(out.message).toContain('***');
  });

  it('callBridge GETs the /linkup URL with caller+called as digits and returns the call id', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200, text: async () => '{"status":"success","unique_id":"b-1"}',
    } as any);
    const out = await new NetsantralClient().callBridge({
      ...creds, caller: '0532 111 22 33', called: '+90 555 444 33 22', trunk: '0850 840 73 03', crmId: 'call-9',
    });
    expect(out).toEqual({ ok: true, callId: 'b-1' });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('crmsntrl.netgsm.com.tr:9111/8508407303/linkup');
    expect(url).toContain('caller=05321112233'); // digits only
    expect(url).toContain('called=905554443322'); // digits only
    expect(url).toContain('trunk=08508407303');
    expect(url).toContain('originate_order=if'); // rep (caller) rings first
    expect(url).toContain('crm_id=call-9');
    expect(url).not.toContain('caller_record'); // recording off by default
  });

  it('callBridge adds caller_record/called_record when record is requested', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200, text: async () => '{"status":"success","unique_id":"b-2"}',
    } as any);
    await new NetsantralClient().callBridge({
      ...creds, caller: '0532', called: '0555', trunk: '850', record: true,
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('caller_record=1');
    expect(url).toContain('called_record=1');
  });

  it('callBridge returns ok:false (no throw) when required params are missing', async () => {
    fetchMock = jest.spyOn(global, 'fetch');
    const out = await new NetsantralClient().callBridge({ ...creds, caller: '', called: '5', trunk: '850' });
    expect(out.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
