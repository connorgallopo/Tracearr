import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const chain = {
  focus: vi.fn(() => chain),
  toggleBold: vi.fn(() => chain),
  toggleItalic: vi.fn(() => chain),
  toggleBulletList: vi.fn(() => chain),
  extendMarkRange: vi.fn(() => chain),
  setLink: vi.fn(() => chain),
  unsetLink: vi.fn(() => chain),
  run: vi.fn(),
};
const active = new Set<string>(['bold']);
const editor = {
  isActive: (name: string) => active.has(name),
  chain: () => chain,
  getAttributes: () => ({ href: 'https://old.example.com' }),
  getJSON: () => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
  }),
};

vi.mock('@tiptap/react', () => ({
  useEditor: () => editor,
  useEditorState: ({ selector }: { selector: (ctx: { editor: typeof editor }) => unknown }) =>
    selector({ editor }),
  EditorContent: () => <div data-testid="editor-content" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

import { RichTextField } from './rich-text-field';

describe('RichTextField', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the four toolbar buttons with aria-pressed from the editor state and a counter', () => {
    render(
      <RichTextField
        id="intro"
        value={null}
        onChange={vi.fn()}
        placeholder="Say hello"
        labelledBy="intro-label"
      />
    );
    expect(screen.getByRole('button', { name: 'newsletters.richText.bold' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'newsletters.richText.italic' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByRole('button', { name: 'newsletters.richText.link' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByRole('button', { name: 'newsletters.richText.bulletList' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(
      screen.getByText('newsletters.richText.counter:{"used":2,"max":2000}')
    ).toBeInTheDocument();
    expect(screen.getByTestId('editor-content')).toBeInTheDocument();
  });

  it('toggles marks through the editor chain', async () => {
    render(
      <RichTextField id="intro" value={null} onChange={vi.fn()} placeholder="" labelledBy="l" />
    );
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.richText.italic' }));
    expect(chain.toggleItalic).toHaveBeenCalledTimes(1);
    expect(chain.run).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.richText.bulletList' }));
    expect(chain.toggleBulletList).toHaveBeenCalledTimes(1);
  });

  it('sets a link only when the href passes the shared grammar and unsets on an empty field', async () => {
    render(
      <RichTextField id="intro" value={null} onChange={vi.fn()} placeholder="" labelledBy="l" />
    );
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.richText.link' }));
    const input = screen.getByLabelText('newsletters.richText.linkHref');
    expect(input).toHaveValue('https://old.example.com');

    await userEvent.clear(input);
    await userEvent.type(input, 'javascript:alert(1)');
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.richText.linkApply' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid URL');
    expect(chain.setLink).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, 'https://discord.gg/x');
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.richText.linkApply' }));
    expect(chain.extendMarkRange).toHaveBeenCalledWith('link');
    expect(chain.setLink).toHaveBeenCalledWith({ href: 'https://discord.gg/x' });

    await userEvent.click(screen.getByRole('button', { name: 'newsletters.richText.link' }));
    await userEvent.clear(screen.getByLabelText('newsletters.richText.linkHref'));
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.richText.linkApply' }));
    expect(chain.unsetLink).toHaveBeenCalledTimes(1);
  });
});
