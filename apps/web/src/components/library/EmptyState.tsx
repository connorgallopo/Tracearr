import { Database, type LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description: string;
}

export function EmptyState({ icon: Icon = Database, title, description }: EmptyStateProps) {
  return (
    <div className="rounded-xl border border-dashed p-8 text-center">
      <Icon className="text-muted-foreground/50 mx-auto h-12 w-12" />
      <h3 className="mt-4 text-lg font-medium">{title}</h3>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md">{description}</p>
    </div>
  );
}
