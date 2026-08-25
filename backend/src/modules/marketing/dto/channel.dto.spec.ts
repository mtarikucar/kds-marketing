import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateChannelDto } from './channel.dto';

/**
 * The accepted channel types, asserted at the DTO.
 *
 * `CHANNEL_TYPES` is where the VOICE defect lived: the inbound voice-AI path
 * resolves a call to a Channel row (netgsm-ivr matches `type: 'VOICE'` on
 * externalId; voice-ai-bridge loads it by id) and ChannelsService.create() is
 * the ONLY code path that writes a Channel — but VOICE was not in this list, so
 * the row could not be created anywhere in the product. The Account Center's
 * Voice "Set up" 400'd here, and the IVR lookup could only ever find nothing.
 *
 * A service-level test does NOT cover this: it passes `type` straight to
 * create() and never runs class-validator, which is exactly why the gap
 * survived.
 */
describe('CreateChannelDto — accepted types', () => {
  const errorsFor = (type: string) =>
    validateSync(plainToInstance(CreateChannelDto, { type, name: 'x' }));

  it('accepts VOICE', () => {
    expect(errorsFor('VOICE')).toHaveLength(0);
  });

  it.each(['WEBCHAT', 'WHATSAPP', 'SMS', 'INSTAGRAM', 'MESSENGER', 'TIKTOK', 'EMAIL'])(
    'still accepts %s',
    (type) => {
      expect(errorsFor(type)).toHaveLength(0);
    },
  );

  it('rejects a type with no adapter behind it', () => {
    // The list is an allow-list, not decoration — widening it is how a channel
    // type reaches a registry that has nothing registered for it.
    expect(errorsFor('TELEGRAM').length).toBeGreaterThan(0);
    expect(errorsFor('').length).toBeGreaterThan(0);
  });
});
