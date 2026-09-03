import { useState } from 'react';
import { RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { clearClientErrors, getClientErrors } from '@/lib/clientErrors';

export function ClientErrors() {
  const [errors, setErrors] = useState(getClientErrors);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TriangleAlert className="h-5 w-5" />
          Browser Errors
          {errors.length > 0 && <Badge variant="secondary">{errors.length}</Badge>}
        </CardTitle>
        <CardDescription>
          Uncaught errors from this tab since it was loaded. Not persisted.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setErrors(getClientErrors())}>
            <RotateCcw />
            Refresh
          </Button>
          <Button
            variant="outline"
            disabled={errors.length === 0}
            onClick={() => {
              clearClientErrors();
              setErrors([]);
            }}
          >
            <Trash2 />
            Clear
          </Button>
        </div>

        {errors.length === 0 ? (
          <p className="text-muted-foreground text-sm">No errors captured</p>
        ) : (
          <div className="space-y-2">
            {errors.map((err) => (
              <div key={err.id} className="bg-muted/30 rounded-md border p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{err.source}</Badge>
                  <span className="text-muted-foreground font-mono">{err.at}</span>
                </div>
                <p className="mt-1.5 font-medium break-words">{err.message}</p>
                {err.stack && (
                  <pre className="text-muted-foreground mt-1.5 max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
                    {err.stack}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
