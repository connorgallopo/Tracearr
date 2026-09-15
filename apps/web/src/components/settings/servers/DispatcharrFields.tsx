import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface DispatcharrForm {
  mode: 'token' | 'credentials';
  token: string;
  username: string;
  password: string;
  ignoreAnonymousStreams: boolean;
}

export const emptyDispatcharrForm = (): DispatcharrForm => ({
  mode: 'credentials',
  token: '',
  username: '',
  password: '',
  ignoreAnonymousStreams: true,
});

export function DispatcharrFields({
  value,
  onChange,
  editing = false,
}: {
  value: DispatcharrForm;
  onChange: (value: DispatcharrForm) => void;
  editing?: boolean;
}) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor="dispatcharr-auth">Authentication</FieldLabel>
        <Select
          value={value.mode}
          onValueChange={(mode: DispatcharrForm['mode']) =>
            onChange({ ...value, mode, token: '', username: '', password: '' })
          }
        >
          <SelectTrigger id="dispatcharr-auth">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="credentials">Username + Password</SelectItem>
            <SelectItem value="token">API Key / JWT Token</SelectItem>
          </SelectContent>
        </Select>
        <FieldDescription>
          Username/password enables WebSocket real-time updates. API key mode uses REST polling.
          Server Resources requires the Dispatcharr Metrics plugin and username/password
          authentication.
        </FieldDescription>
      </Field>
      {value.mode === 'credentials' ? (
        <>
          <Field>
            <FieldLabel htmlFor="dispatcharr-username">Username</FieldLabel>
            <Input
              id="dispatcharr-username"
              autoComplete="off"
              value={value.username}
              onChange={(e) => onChange({ ...value, username: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="dispatcharr-password">Password</FieldLabel>
            <Input
              id="dispatcharr-password"
              type="password"
              autoComplete="new-password"
              value={value.password}
              onChange={(e) => onChange({ ...value, password: e.target.value })}
            />
          </Field>
        </>
      ) : (
        <Field>
          <FieldLabel htmlFor="dispatcharr-token">API Key / JWT Token</FieldLabel>
          <Input
            id="dispatcharr-token"
            type="password"
            autoComplete="new-password"
            value={value.token}
            onChange={(e) => onChange({ ...value, token: e.target.value })}
          />
        </Field>
      )}
      {editing && (
        <p className="text-muted-foreground text-sm">
          Leave authentication fields blank to keep the current credentials. Switching modes
          requires complete replacement credentials.
        </p>
      )}
      <Field orientation="horizontal">
        <Checkbox
          id="dispatcharr-anonymous"
          checked={value.ignoreAnonymousStreams}
          onCheckedChange={(checked) =>
            onChange({ ...value, ignoreAnonymousStreams: checked === true })
          }
        />
        <FieldLabel htmlFor="dispatcharr-anonymous">Ignore Anonymous streams</FieldLabel>
      </Field>
    </>
  );
}
