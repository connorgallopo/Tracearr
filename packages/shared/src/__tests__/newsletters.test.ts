import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NEWSLETTER_SECTIONS,
  DEFAULT_NEWSLETTER_SUBJECT,
  NEWSLETTER_SECTION_MAX,
  createNewsletterSchema,
  cronExpressionSchema,
  emailSuppressionCreateSchema,
  newsletterCron,
  newsletterScheduleSchema,
  newsletterTestSendSchema,
  updateNewsletterSchema,
  updateUserIdentitySchema,
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
      scope: { serverIds: [], libraryIds: [] },
      sections: DEFAULT_NEWSLETTER_SECTIONS,
      subject: DEFAULT_NEWSLETTER_SUBJECT,
      intro: null,
      outro: null,
      recipients: { members: true, extraAddresses: [] },
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
    ['an unknown key', { colour: 'red' }],
  ])('rejects %s', (_label, patch) => {
    expect(createNewsletterSchema.safeParse({ ...minimal, ...patch }).success).toBe(false);
  });

  it('accepts a full body and keeps nullable copy', () => {
    const parsed = createNewsletterSchema.safeParse({
      ...minimal,
      destinationId: '11111111-1111-4111-8111-111111111111',
      window: { kind: 'fixed', days: 14 },
      scope: { serverIds: ['22222222-2222-4222-8222-222222222222'], libraryIds: ['1', '2'] },
      intro: 'Hello',
      outro: null,
      recipients: { members: false, extraAddresses: [{ address: 'A@Example.com', name: 'A' }] },
      imageMode: 'inline',
      skipWhenEmpty: false,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.recipients.extraAddresses[0]?.address).toBe('a@example.com');
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
