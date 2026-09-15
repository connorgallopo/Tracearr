import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bold as BoldIcon, Italic as ItalicIcon, Link2, List } from 'lucide-react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { Bold } from '@tiptap/extension-bold';
import { Document } from '@tiptap/extension-document';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Italic } from '@tiptap/extension-italic';
import { Link } from '@tiptap/extension-link';
import { BulletList } from '@tiptap/extension-list/bullet-list';
import { ListItem } from '@tiptap/extension-list/item';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Text } from '@tiptap/extension-text';
import {
  EMAIL_RICH_TEXT_MAX_CHARS,
  emailRichTextHrefSchema,
  type EmailRichTextDoc,
} from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { parseRichText, type RichTextChange } from '@/components/ui/rich-text-normalize';
import { cn } from '@/lib/utils';

interface RichTextFieldProps {
  id: string;
  /** The document the field opens on; later prop changes do not reset the editor, so key the field by the row it edits. */
  value: EmailRichTextDoc | null;
  onChange: (change: RichTextChange) => void;
  placeholder: string;
  labelledBy: string;
}

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };
const SAFE_HREF = /^(https:\/\/|mailto:)/i;

/** Only these extensions exist, so the editor's own schema cannot express anything outside the shared grammar. */
const extensions = (placeholder: string) => [
  Document,
  Paragraph,
  Text,
  Bold,
  Italic,
  HardBreak,
  BulletList,
  ListItem,
  Link.configure({
    openOnClick: false,
    autolink: true,
    defaultProtocol: 'https',
    protocols: ['https', 'mailto'],
    isAllowedUri: (url) => SAFE_HREF.test(url),
    HTMLAttributes: { rel: null, target: null },
  }),
  Placeholder.configure({ placeholder }),
];

export function RichTextField({
  id,
  value,
  onChange,
  placeholder,
  labelledBy,
}: RichTextFieldProps) {
  const { t } = useTranslation('settings');
  const [error, setError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');
  const [hrefError, setHrefError] = useState<string | null>(null);

  const editor = useEditor({
    extensions: extensions(placeholder),
    content: value ?? EMPTY_DOC,
    editorProps: {
      attributes: {
        id,
        'aria-labelledby': labelledBy,
        class: 'tiptap min-h-24 px-3 py-2 text-sm outline-none',
      },
    },
    onUpdate: ({ editor: updated }) => {
      const change = parseRichText(updated.getJSON());
      setLength(change.length);
      setError(change.error);
      onChange({ value: change.value, error: change.error });
    },
  });

  /** The editor renders synchronously on mount (client-only, not Next.js), so its own JSON is the true initial length. */
  const [length, setLength] = useState(() => (editor ? parseRichText(editor.getJSON()).length : 0));

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            link: e.isActive('link'),
            bulletList: e.isActive('bulletList'),
          }
        : { bold: false, italic: false, link: false, bulletList: false },
  });

  if (!editor) return null;

  const openLink = (open: boolean) => {
    if (open) {
      const current = editor.getAttributes('link') as { href?: string };
      setHref(current.href ?? '');
      setHrefError(null);
    }
    setLinkOpen(open);
  };

  const applyLink = () => {
    const trimmed = href.trim();
    if (trimmed === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      setLinkOpen(false);
      return;
    }
    const parsed = emailRichTextHrefSchema.safeParse(trimmed);
    if (!parsed.success) {
      setHrefError(parsed.error.issues[0]?.message ?? 'Invalid URL');
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: parsed.data }).run();
    setLinkOpen(false);
  };

  const toggle = (label: string, pressed: boolean, Icon: typeof BoldIcon, run: () => void) => (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={label}
      aria-pressed={pressed}
      className={cn(pressed && 'bg-accent')}
      onClick={run}
    >
      <Icon />
    </Button>
  );

  return (
    <div className="border-input focus-within:ring-ring/50 rounded-md border shadow-xs focus-within:ring-[3px]">
      <div className="flex items-center justify-between gap-2 border-b px-2 py-1">
        <ButtonGroup>
          {toggle(t('newsletters.richText.bold'), state.bold, BoldIcon, () =>
            editor.chain().focus().toggleBold().run()
          )}
          {toggle(t('newsletters.richText.italic'), state.italic, ItalicIcon, () =>
            editor.chain().focus().toggleItalic().run()
          )}
          <Popover open={linkOpen} onOpenChange={openLink}>
            <PopoverTrigger asChild>
              {toggle(t('newsletters.richText.link'), state.link, Link2, () => undefined)}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 space-y-2">
              <label htmlFor={`${id}-link`} className="text-sm font-medium">
                {t('newsletters.richText.linkHref')}
              </label>
              <Input
                id={`${id}-link`}
                value={href}
                placeholder="https://"
                aria-invalid={hrefError !== null}
                onChange={(event) => setHref(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    applyLink();
                  }
                }}
              />
              <FieldError>{hrefError}</FieldError>
              <div className="flex justify-end gap-2">
                <Button type="button" size="sm" onClick={applyLink}>
                  {t('newsletters.richText.linkApply')}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          {toggle(t('newsletters.richText.bulletList'), state.bulletList, List, () =>
            editor.chain().focus().toggleBulletList().run()
          )}
        </ButtonGroup>
        <span
          className={cn(
            'text-muted-foreground text-xs tabular-nums',
            length > EMAIL_RICH_TEXT_MAX_CHARS && 'text-destructive'
          )}
        >
          {t('newsletters.richText.counter', { used: length, max: EMAIL_RICH_TEXT_MAX_CHARS })}
        </span>
      </div>
      <EditorContent editor={editor} />
      <FieldError className="px-3 pb-2">{error}</FieldError>
    </div>
  );
}
