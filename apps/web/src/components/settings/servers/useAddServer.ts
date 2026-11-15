import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SERVER_PROFILES, assertNever, type Server, type ServerType } from '@tracearr/shared';
import { api, type PlexDiscoveredServer } from '@/lib/api';
import { addsByApiKey, holdsApiKey } from '@/lib/serverType';
import { useAuth } from '@/hooks/useAuth';
import { useServers } from '@/hooks/queries';
import { useTofaSignIn } from '@/components/auth/useTofaSignIn';

export type PlexDialogStep =
  'loading' | 'no-accounts' | 'select-account' | 'loading-servers' | 'no-servers' | 'select';

export interface PlexAccountOption {
  id: string;
  plexUsername: string | null;
  plexEmail: string | null;
}

export type AddServerForm = ReturnType<typeof useAddServer>;

export type AddedServer = Pick<Server, 'id' | 'type'>;

/**
 * The add-server form: a Plex server picked from a linked account, a tofa server picked after
 * signing in to tofa, or a Jellyfin, Emby or tofa server by URL and API key. onAdded runs once a
 * server is in, before the form resets; when the caller has to say first that its key cannot stop
 * streams, it runs on continueAdded instead.
 */
export function useAddServer({
  initialType,
  onAdded,
}: {
  initialType?: ServerType;
  onAdded: (server: AddedServer) => void;
}) {
  const { t } = useTranslation(['settings', 'notifications']);
  const { refetch } = useServers();
  const queryClient = useQueryClient();
  const { refetch: refetchUser, user } = useAuth();
  const isOwner = user?.role === 'owner';
  const defaultType = initialType ?? (isOwner ? 'plex' : 'jellyfin');

  const [chosenType, setServerType] = useState<ServerType>(initialType ?? 'plex');
  const [serverUrl, setServerUrl] = useState('');
  const [publicUrl, setPublicUrl] = useState('');
  const [serverName, setServerName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [addedWithoutStop, setAddedWithoutStop] = useState<AddedServer | null>(null);
  const [plexStep, setPlexStep] = useState<PlexDialogStep>('loading');
  const [plexServers, setPlexServers] = useState<PlexDiscoveredServer[]>([]);
  const [connectingPlexServer, setConnectingPlexServer] = useState<string | null>(null);
  const [plexAccounts, setPlexAccounts] = useState<PlexAccountOption[]>([]);
  const [selectedPlexAccountId, setSelectedPlexAccountId] = useState<string | null>(null);
  const [enterKey, setEnterKey] = useState(false);

  // Only the owner adds Plex servers, and the session can arrive after the first render
  const serverType: ServerType =
    user && !isOwner && SERVER_PROFILES[chosenType].addServerAuth === 'plexOAuth'
      ? 'jellyfin'
      : chosenType;
  // Only the owner can sign in to tofa to add a server; anyone else types its URL and key.
  const keyFields =
    holdsApiKey(serverType) &&
    (addsByApiKey(serverType) || enterKey || (user !== null && !isOwner));

  const tofa = useTofaSignIn({
    purpose: 'add-server',
    onAdded: async ({ server }) => {
      await Promise.all([refetchUser(), refetch()]);
      added(server);
    },
  });

  const fetchPlexServers = async (accountId?: string) => {
    setPlexStep('loading-servers');
    setConnectError(null);

    try {
      const result = await api.auth.getAvailablePlexServers(accountId);
      if (!result.hasPlexToken) {
        setPlexStep('no-accounts');
        return;
      }
      if (result.servers.length === 0) {
        setPlexStep('no-servers');
        return;
      }
      setPlexServers(result.servers);
      setPlexStep('select');
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'Failed to fetch Plex servers');
      setPlexStep('no-servers');
    }
  };

  const loadPlexAccounts = async () => {
    setPlexStep('loading');
    setConnectError(null);

    try {
      const { accounts } = await api.auth.getPlexAccounts();
      if (accounts.length === 0) {
        setPlexStep('no-accounts');
        return;
      }
      setPlexAccounts(accounts);

      const firstAccount = accounts[0];
      if (accounts.length === 1 && firstAccount) {
        setSelectedPlexAccountId(firstAccount.id);
        await fetchPlexServers(firstAccount.id);
      } else {
        setPlexStep('select-account');
      }
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'Failed to fetch Plex accounts');
      setPlexStep('no-accounts');
    }
  };

  const reset = () => {
    setServerUrl('');
    setPublicUrl('');
    setServerName('');
    setApiKey('');
    setConnectError(null);
    setAddedWithoutStop(null);
    setServerType(defaultType);
    setPlexStep('loading');
    setPlexServers([]);
    setConnectingPlexServer(null);
    setPlexAccounts([]);
    setSelectedPlexAccountId(null);
    setEnterKey(false);
    tofa.cancel();
  };

  const added = (server: AddedServer & Partial<Pick<Server, 'name' | 'canStopStreams'>>) => {
    if (server.canStopStreams === false) {
      setServerName(server.name ?? '');
      setAddedWithoutStop(server);
      return;
    }
    onAdded(server);
    reset();
  };

  const continueAdded = () => {
    if (!addedWithoutStop) return;
    onAdded(addedWithoutStop);
    reset();
  };

  const changeServerType = (type: ServerType) => {
    setServerType(type);
    setConnectError(null);
    setEnterKey(false);
    tofa.cancel();
    if (SERVER_PROFILES[type].addServerAuth === 'plexOAuth' && isOwner) {
      void loadPlexAccounts();
    }
  };

  const selectPlexAccount = (id: string) => {
    setSelectedPlexAccountId(id);
    void fetchPlexServers(id);
  };

  const selectPlexServer = async (uri: string, name: string, clientIdentifier: string) => {
    setConnectingPlexServer(name);
    setConnectError(null);

    try {
      const { server } = await api.auth.addPlexServer({
        serverUri: uri,
        serverName: name,
        clientIdentifier,
        accountId: selectedPlexAccountId ?? undefined,
      });
      toast.success(t('notifications:toast.success.serverAdded.title'), {
        description: t('notifications:toast.success.serverAdded.message', { name }),
      });
      await refetch();
      await refetchUser();
      void queryClient.invalidateQueries({ queryKey: ['plex-accounts'] });
      onAdded(server);
      reset();
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'Failed to connect Plex server');
    } finally {
      setConnectingPlexServer(null);
    }
  };

  const testPlexUrl = async (uri: string) => {
    const result = await api.auth.testPlexConnection({
      uri,
      accountId: selectedPlexAccountId ?? undefined,
    });
    return result.connection;
  };

  const connect = async () => {
    if (!holdsApiKey(serverType)) return;
    if (!serverUrl || !serverName || !apiKey) {
      setConnectError(t('servers.allFieldsRequired'));
      return;
    }

    setIsConnecting(true);
    setConnectError(null);

    try {
      const address = publicUrl.trim() ? { publicUrl: publicUrl.trim() } : {};
      let server: AddedServer & Partial<Pick<Server, 'name' | 'canStopStreams'>>;
      switch (serverType) {
        case 'jellyfin': {
          const fields = { serverUrl, serverName, apiKey, ...address };
          const { serverId } = await api.auth.connectJellyfinWithApiKey(fields);
          server = { id: serverId, type: serverType };
          break;
        }
        case 'emby': {
          const fields = { serverUrl, serverName, apiKey, ...address };
          const { serverId } = await api.auth.connectEmbyWithApiKey(fields);
          server = { id: serverId, type: serverType };
          break;
        }
        case 'tofa':
          server = await api.servers.create({
            name: serverName,
            type: serverType,
            url: serverUrl,
            token: apiKey,
            ...address,
          });
          break;
        default:
          assertNever(serverType);
      }
      await refetchUser();
      await refetch();
      added(server);
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'Failed to connect server');
    } finally {
      setIsConnecting(false);
    }
  };

  return {
    isOwner,
    serverType,
    changeServerType,
    serverUrl,
    setServerUrl,
    publicUrl,
    setPublicUrl,
    serverName,
    setServerName,
    apiKey,
    setApiKey,
    isConnecting,
    busy: isConnecting || connectingPlexServer !== null || tofa.connectingTo !== null,
    connectError,
    connect,
    addedWithoutStop: addedWithoutStop !== null,
    continueAdded,
    keyFields,
    enterKeyFields: () => setEnterKey(true),
    tofa,
    plexStep,
    plexAccounts,
    selectedPlexAccountId,
    selectPlexAccount,
    plexServers,
    connectingPlexServer,
    selectPlexServer,
    testPlexUrl,
    loadPlexAccounts,
    reset,
  };
}
