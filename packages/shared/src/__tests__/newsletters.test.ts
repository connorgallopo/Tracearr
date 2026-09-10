import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMAIL_BRANDING,
  DEFAULT_NEWSLETTER_SECTIONS,
  DEFAULT_NEWSLETTER_SUBJECT,
  NEWSLETTER_SECTION_MAX,
  createNewsletterSchema,
  cronExpressionSchema,
  emailBrandingSchema,
  emailBrandingReadSchema,
  emailSuppressionCreateSchema,
  needsSenderName,
  newsletterCron,
  newsletterPreviewDraftSchema,
  newsletterScheduleSchema,
  newsletterTestSendSchema,
  resolveSenderName,
  updateNewsletterSchema,
  updateUserIdentitySchema,
  variantKey,
  variantServerIds,
} from '../index.js';

const minimal = {
  name: 'Weekly',
  schedule: { kind: 'weekly', dayOfWeek: 5, time: '18:00' },
  timezone: 'America/New_York',
};

describe('createNewsletterSchema', () => {
  it('fills every default from a minimal body', () => {
    const parsed = createNewsletterSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      enabled: true,
      destinationId: null,
      window: { kind: 'since_last_send', fallbackDays: 7 },
      scope: { serverIds: [], libraries: [] },
      sections: DEFAULT_NEWSLETTER_SECTIONS,
      subject: DEFAULT_NEWSLETTER_SUBJECT,
      intro: null,
      outro: null,
      senderName: null,
      links: { tracearr: false },
      recipients: { members: true, extraAddresses: [], excludeUserIds: [] },
      imageMode: 'auto',
      skipWhenEmpty: true,
    });
  });

  it.each([
    [
      'a cap above the maximum',
      {
        sections: {
          ...DEFAULT_NEWSLETTER_SECTIONS,
          movies: { enabled: true, max: NEWSLETTER_SECTION_MAX + 1 },
        },
      },
    ],
    [
      'most watched above ten',
      { sections: { ...DEFAULT_NEWSLETTER_SECTIONS, mostWatched: { enabled: true, max: 11 } } },
    ],
    ['a window over 31 days', { window: { kind: 'fixed', days: 32 } }],
    ['a bad time', { schedule: { kind: 'daily', time: '25:00' } }],
    ['a day of month past 28', { schedule: { kind: 'monthly', dayOfMonth: 29, time: '08:00' } }],
    ['a cron with four fields', { schedule: { kind: 'cron', expression: '0 8 * *' } }],
    ['a cron with letters', { schedule: { kind: 'cron', expression: '0 8 * * MON' } }],
    ['an invalid timezone', { timezone: 'Mars/Olympus' }],
    [
      'a bad extra address',
      { recipients: { members: true, extraAddresses: [{ address: 'nope' }] } },
    ],
    ['an unknown image mode', { imageMode: 'base64' }],
    ['a string intro', { intro: 'plain' }],
    ['an empty sender name', { senderName: '' }],
    ['a sender name over 100 characters', { senderName: 'x'.repeat(101) }],
    ['an unknown links key', { links: { tracearr: true, imdb: true } }],
    [
      'a non-uuid excluded user',
      { recipients: { members: true, extraAddresses: [], excludeUserIds: ['nope'] } },
    ],
    ['an unknown key', { colour: 'red' }],
    ['the old bare library id list', { scope: { serverIds: [], libraryIds: ['1'] } }],
    [
      'a library pair without a server',
      { scope: { serverIds: [], libraries: [{ libraryId: '1' }] } },
    ],
  ])('rejects %s', (_label, patch) => {
    expect(createNewsletterSchema.safeParse({ ...minimal, ...patch }).success).toBe(false);
  });

  it('accepts a full body and keeps nullable copy', () => {
    const parsed = createNewsletterSchema.safeParse({
      ...minimal,
      destinationId: '11111111-1111-4111-8111-111111111111',
      window: { kind: 'fixed', days: 14 },
      scope: {
        serverIds: ['22222222-2222-4222-8222-222222222222'],
        libraries: [
          { serverId: '22222222-2222-4222-8222-222222222222', libraryId: '1' },
          { serverId: '22222222-2222-4222-8222-222222222222', libraryId: '2' },
        ],
      },
      intro: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
      },
      outro: { type: 'doc', content: [{ type: 'paragraph' }] },
      senderName: '  Family Media ',
      links: { tracearr: true },
      recipients: {
        members: false,
        extraAddresses: [{ address: 'A@Example.com', name: 'A' }],
        excludeUserIds: ['33333333-3333-4333-8333-333333333333'],
      },
      imageMode: 'inline',
      skipWhenEmpty: false,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.recipients.extraAddresses[0]?.address).toBe('a@example.com');
    expect(parsed.data.outro).toBeNull();
    expect(parsed.data.senderName).toBe('Family Media');
    expect(parsed.data.intro?.content[0]?.type).toBe('paragraph');
  });

  it('requires a timezone', () => {
    const { timezone: _omitted, ...withoutTimezone } = minimal;
    expect(createNewsletterSchema.safeParse(withoutTimezone).success).toBe(false);
    expect(createNewsletterSchema.safeParse({ ...minimal, timezone: undefined }).success).toBe(
      false
    );
  });
});

describe('updateNewsletterSchema', () => {
  it('is a partial with the same rejections', () => {
    expect(updateNewsletterSchema.safeParse({}).success).toBe(true);
    expect(updateNewsletterSchema.safeParse({ name: '' }).success).toBe(false);
    expect(updateNewsletterSchema.safeParse({ imageMode: 'none' }).success).toBe(true);
    expect(updateNewsletterSchema.safeParse({ colour: 'red' }).success).toBe(false);
  });

  it('leaves absent keys absent instead of filling create defaults', () => {
    expect(updateNewsletterSchema.parse({})).toEqual({});
    expect(updateNewsletterSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(updateNewsletterSchema.parse({ window: { kind: 'fixed', days: 3 } })).toEqual({
      window: { kind: 'fixed', days: 3 },
    });
    expect(updateNewsletterSchema.safeParse({ bogus: 1 }).success).toBe(false);
    expect(updateNewsletterSchema.parse({ links: { tracearr: true } })).toEqual({
      links: { tracearr: true },
    });
    expect(updateNewsletterSchema.parse({ intro: { type: 'doc', content: [] } })).toEqual({
      intro: null,
    });
  });
});

describe('newsletterCron', () => {
  it('derives five-field cron strings', () => {
    expect(newsletterCron({ kind: 'daily', time: '08:30' })).toBe('30 8 * * *');
    expect(newsletterCron({ kind: 'weekly', dayOfWeek: 0, time: '18:05' })).toBe('5 18 * * 0');
    expect(newsletterCron({ kind: 'monthly', dayOfMonth: 1, time: '00:00' })).toBe('0 0 1 * *');
    expect(newsletterCron({ kind: 'cron', expression: '15 */6 * * 1-5' })).toBe('15 */6 * * 1-5');
  });
  it('the schedule schema accepts what newsletterCron consumes', () => {
    expect(
      newsletterScheduleSchema.safeParse({ kind: 'cron', expression: '15 */6 * * 1-5' }).success
    ).toBe(true);
    expect(cronExpressionSchema.safeParse(' 0 8 * * * ').success).toBe(true);
  });
});

describe('small bodies', () => {
  it('lowercase addresses for test sends and suppressions', () => {
    expect(newsletterTestSendSchema.parse({ address: 'Me@Example.COM' }).address).toBe(
      'me@example.com'
    );
    expect(emailSuppressionCreateSchema.parse({ address: 'Me@Example.COM' }).address).toBe(
      'me@example.com'
    );
  });
  it('identity updates accept a nullable contact email', () => {
    expect(updateUserIdentitySchema.safeParse({ contactEmail: null }).success).toBe(true);
    expect(updateUserIdentitySchema.parse({ contactEmail: 'Who@Example.com' }).contactEmail).toBe(
      'who@example.com'
    );
    expect(updateUserIdentitySchema.safeParse({ contactEmail: 'nope' }).success).toBe(false);
  });
});

describe('emailBrandingSchema', () => {
  it('fills every default from an empty object', () => {
    expect(emailBrandingSchema.parse({})).toEqual({
      logo: { mode: 'tracearr' },
      accentColor: '#0ea0b3',
      footerText: null,
      postalAddress: null,
      mailtoUnsubscribe: false,
    });
    expect(DEFAULT_EMAIL_BRANDING).toEqual(emailBrandingSchema.parse({}));
  });

  it('accepts a url logo over http or https and nothing else', () => {
    expect(
      emailBrandingSchema.safeParse({ logo: { mode: 'url', url: 'https://x.test/logo.png' } })
        .success
    ).toBe(true);
    expect(
      emailBrandingSchema.safeParse({ logo: { mode: 'url', url: 'ftp://x.test/a' } }).success
    ).toBe(false);
    expect(
      emailBrandingSchema.safeParse({ logo: { mode: 'url', url: 'javascript:alert(1)' } }).success
    ).toBe(false);
    expect(emailBrandingSchema.safeParse({ logo: { mode: 'url' } }).success).toBe(false);
    expect(emailBrandingSchema.safeParse({ logo: { mode: 'tracearr', url: 'x' } }).success).toBe(
      false
    );
  });

  it('rejects a logo URL containing embedded control characters', () => {
    expect(
      emailBrandingSchema.safeParse({
        logo: { mode: 'url', url: 'https://x.test/logo.png\r\nEvil-Header: 1' },
      }).success
    ).toBe(false);
  });

  it('requires a six-digit hex accent and trims the text fields', () => {
    expect(emailBrandingSchema.safeParse({ accentColor: '0ea0b3' }).success).toBe(false);
    expect(emailBrandingSchema.safeParse({ accentColor: '#abc' }).success).toBe(false);
    const parsed = emailBrandingSchema.parse({
      footerText: ' see you next week ',
      postalAddress: null,
    });
    expect(parsed.footerText).toBe('see you next week');
    expect(emailBrandingSchema.safeParse({ footerText: 'x'.repeat(501) }).success).toBe(false);
  });

  it('rejects unknown keys on write and strips them on read', () => {
    expect(emailBrandingSchema.safeParse({ theme: 'dark' }).success).toBe(false);
    expect(emailBrandingSchema.safeParse({ senderName: 'Movies' }).success).toBe(false);
    expect(emailBrandingReadSchema.parse({ senderName: 'Movies', accentColor: '#123456' })).toEqual(
      {
        logo: { mode: 'tracearr' },
        accentColor: '#123456',
        footerText: null,
        postalAddress: null,
        mailtoUnsubscribe: false,
      }
    );
  });
});

describe('resolveSenderName', () => {
  it('prefers the newsletter name, then the one scoped server, then Tracearr', () => {
    expect(resolveSenderName('Family Media', ['Basement'])).toBe('Family Media');
    expect(resolveSenderName(null, ['Basement'])).toBe('Basement');
    expect(resolveSenderName(null, ['Basement', 'Attic'])).toBe('Tracearr');
    expect(resolveSenderName(null, [])).toBe('Tracearr');
  });
});

describe('variants', () => {
  it('keys a variant by its sorted server ids and intersects a member with the scope in scope order', () => {
    expect(variantKey(['b', 'a', 'b'])).toBe('a,b');
    expect(variantServerIds(['c', 'a'], ['a', 'b', 'c'])).toEqual(['a', 'c']);
    expect(variantServerIds(null, ['b', 'a'])).toEqual(['b', 'a']);
    expect(variantServerIds(['z'], ['a'])).toEqual([]);
  });

  it('needs a sender name only when none is set and the scope has several servers', () => {
    expect(needsSenderName(null, 2)).toBe(true);
    expect(needsSenderName('Family Media', 2)).toBe(false);
    expect(needsSenderName(null, 1)).toBe(false);
  });

  it('accepts a test send with a sorted variant key and refuses an unsorted or malformed one', () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    expect(
      newsletterTestSendSchema.parse({ address: 'Me@X.com', variantKey: `${a},${b}` })
    ).toEqual({ address: 'me@x.com', variantKey: `${a},${b}` });
    expect(newsletterTestSendSchema.parse({ address: 'me@x.com' })).toEqual({
      address: 'me@x.com',
    });
    expect(
      newsletterTestSendSchema.safeParse({ address: 'me@x.com', variantKey: `${b},${a}` }).success
    ).toBe(false);
    expect(
      newsletterTestSendSchema.safeParse({ address: 'me@x.com', variantKey: 'nope' }).success
    ).toBe(false);
  });
});

describe('newsletterPreviewDraftSchema', () => {
  it('parses a create body with an optional newsletter id, applying the create defaults', () => {
    const body = {
      newsletter: {
        name: 'Weekly',
        schedule: { kind: 'weekly', dayOfWeek: 1, time: '09:00' },
        timezone: 'UTC',
      },
    };
    const parsed = newsletterPreviewDraftSchema.parse(body);
    expect(parsed.newsletterId).toBeUndefined();
    expect(parsed.newsletter.window).toEqual({ kind: 'since_last_send', fallbackDays: 7 });
    expect(
      newsletterPreviewDraftSchema.parse({
        ...body,
        newsletterId: '11111111-1111-4111-8111-111111111111',
      }).newsletterId
    ).toBe('11111111-1111-4111-8111-111111111111');
    expect(newsletterPreviewDraftSchema.safeParse({ ...body, newsletterId: 'nope' }).success).toBe(
      false
    );
    expect(newsletterPreviewDraftSchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });
});
