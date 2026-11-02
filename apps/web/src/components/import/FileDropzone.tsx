import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileJson, Upload, X } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '@/lib/utils';

interface FileDropzoneProps {
  accept?: string;
  maxSize?: number; // in bytes
  onFileSelect: (file: File | null) => void;
  selectedFile: File | null;
  disabled?: boolean;
  error?: string | null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function FileDropzone({
  accept = '.json',
  maxSize = 100 * 1024 * 1024, // 100MB default
  onFileSelect,
  selectedFile,
  disabled = false,
  error,
}: FileDropzoneProps) {
  const { t } = useTranslation('settings');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!disabled) {
        setIsDragging(true);
      }
    },
    [disabled]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const validateAndSelect = useCallback(
    (file: File) => {
      // Validate extension
      const extensions = accept.split(',').map((ext) => ext.trim().toLowerCase());
      const fileExt = `.${file.name.split('.').pop()?.toLowerCase()}`;

      if (!extensions.includes(fileExt) && !extensions.includes('*')) {
        onFileSelect(null);
        return;
      }

      // Validate size
      if (file.size > maxSize) {
        onFileSelect(null);
        return;
      }

      onFileSelect(file);
    },
    [accept, maxSize, onFileSelect]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      if (disabled) return;

      const file = e.dataTransfer.files[0];
      if (file) {
        validateAndSelect(file);
      }
    },
    [disabled, validateAndSelect]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        validateAndSelect(file);
      }
    },
    [validateAndSelect]
  );

  const handleRemoveFile = useCallback(() => {
    onFileSelect(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [onFileSelect]);

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return (
    <div className="space-y-2">
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        onChange={handleFileChange}
        className="hidden"
        disabled={disabled}
      />

      {!selectedFile ? (
        <button
          type="button"
          onClick={handleClick}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          disabled={disabled}
          className={cn(
            'focus-visible:border-ring focus-visible:ring-ring/50 flex w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 transition-colors outline-none focus-visible:ring-[3px]',
            isDragging && 'border-primary bg-primary/5',
            !isDragging &&
              'border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/50',
            disabled && 'cursor-not-allowed opacity-50',
            error && 'border-destructive'
          )}
        >
          <span className={cn('rounded-full p-3', isDragging ? 'bg-primary/10' : 'bg-muted')}>
            <Upload
              className={cn('h-6 w-6', isDragging ? 'text-primary' : 'text-muted-foreground')}
            />
          </span>
          <span className="text-center">
            <span className="block font-medium">
              {isDragging ? t('import.dropzone.dropHere') : t('import.dropzone.dragOrClick')}
            </span>
            <span className="text-muted-foreground mt-1 block text-sm">
              {t('import.dropzone.limit', { accept, size: formatFileSize(maxSize) })}
            </span>
          </span>
        </button>
      ) : (
        <div className="bg-muted/30 flex items-center gap-3 rounded-lg border p-3">
          <div className="bg-primary/10 rounded-lg p-2">
            <FileJson className="text-primary h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{selectedFile.name}</p>
            <p className="text-muted-foreground text-sm">{formatFileSize(selectedFile.size)}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRemoveFile}
            disabled={disabled}
            className="shrink-0"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">{t('import.dropzone.removeFile')}</span>
          </Button>
        </div>
      )}

      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}
