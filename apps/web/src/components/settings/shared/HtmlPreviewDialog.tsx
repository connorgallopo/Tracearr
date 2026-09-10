import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

/** The digest is a fixed 600px table; 375px is the narrowest phone it has to survive. */
export const PREVIEW_WIDTHS = { desktop: 600, phone: 375 } as const;
type PreviewWidth = keyof typeof PREVIEW_WIDTHS;
type Images = 'shown' | 'blocked';

/** What a client with remote images off shows: every img keeps its alt and loses its src. */
export function withoutImages(html: string): string {
  return html.replace(/<(img)\b([^>]*?)\s+src=(?:"[^"]*"|'[^']*')/gi, '<$1$2');
}

/** Owner-authored html goes through an empty sandbox: never allow-scripts together with allow-same-origin. */
export function HtmlPreviewDialog({
  open,
  onOpenChange,
  title,
  subject,
  meta,
  notice,
  html,
  loading = false,
  draft = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subject?: string;
  meta?: ReactNode;
  /** What this render cannot show, if anything; a sent copy passes none. */
  notice?: string;
  html: string | null;
  loading?: boolean;
  /** The render came from unsaved form state rather than the saved row. */
  draft?: boolean;
}) {
  const { t } = useTranslation('settings');
  const widthLabelId = useId();
  const imagesLabelId = useId();
  const [width, setWidth] = useState<PreviewWidth>('desktop');
  const [images, setImages] = useState<Images>('shown');
  const ready = !loading && html !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setWidth('desktop');
          setImages('shown');
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex h-[80vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {title}
            {draft && <Badge variant="outline">{t('newsletters.editor.preview.draft')}</Badge>}
          </DialogTitle>
          {subject && (
            <DialogDescription>
              <span className="text-foreground font-medium">
                {t('newsletters.editor.preview.subjectLabel')}:
              </span>{' '}
              {subject}
            </DialogDescription>
          )}
        </DialogHeader>
        {meta}
        {ready && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span id={widthLabelId} className="text-muted-foreground">
                {t('newsletters.editor.preview.width')}
              </span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={width}
                onValueChange={(next) => next && setWidth(next as PreviewWidth)}
                aria-labelledby={widthLabelId}
              >
                <ToggleGroupItem value="desktop">
                  {t('newsletters.editor.preview.widths.desktop')}
                </ToggleGroupItem>
                <ToggleGroupItem value="phone">
                  {t('newsletters.editor.preview.widths.phone')}
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
            <div className="flex items-center gap-2">
              <span id={imagesLabelId} className="text-muted-foreground">
                {t('newsletters.editor.preview.images')}
              </span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={images}
                onValueChange={(next) => next && setImages(next as Images)}
                aria-labelledby={imagesLabelId}
              >
                <ToggleGroupItem value="shown">
                  {t('newsletters.editor.preview.imagesOn')}
                </ToggleGroupItem>
                <ToggleGroupItem value="blocked">
                  {t('newsletters.editor.preview.imagesBlocked')}
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
            {images === 'blocked' && (
              <p className="text-muted-foreground basis-full">
                {t('newsletters.editor.preview.imagesBlockedNote')}
              </p>
            )}
            {notice && <p className="text-muted-foreground basis-full">{notice}</p>}
          </div>
        )}
        {loading ? (
          <Skeleton data-testid="html-preview-loading" className="min-h-0 w-full flex-1" />
        ) : (
          ready && (
            <iframe
              title={title}
              sandbox=""
              srcDoc={images === 'blocked' ? withoutImages(html) : html}
              style={{ width: `${PREVIEW_WIDTHS[width]}px` }}
              className="mx-auto block min-h-0 max-w-full flex-1 rounded-md border bg-[#0f1115]"
            />
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
