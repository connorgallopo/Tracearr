/**
 * Server selector component for the drawer
 * Multi-select (checkboxes) on dashboard, single-select (radio) on other tabs
 */
import { Check, ChevronDown, Server, Square, SquareCheck } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, Text, TouchableOpacity, View } from 'react-native';
import { ACCENT_COLOR, colors } from '../lib/theme';
import { useMediaServer } from '../providers/MediaServerProvider';
import { useTranslation } from '@tracearr/translations/mobile';

interface ServerSelectorProps {
  multiSelect?: boolean;
}

export function ServerSelector({ multiSelect = false }: ServerSelectorProps) {
  const { t } = useTranslation(['mobile', 'common']);
  const {
    servers,
    selectedServerIds,
    selectedServers,
    isMultiServer,
    isAllServersSelected,
    toggleServer,
    selectAllServers,
    selectServer,
    isLoading,
  } = useMediaServer();
  const [modalVisible, setModalVisible] = useState(false);

  if (isLoading) {
    return (
      <View className="flex-row items-center px-3">
        <ActivityIndicator size="small" color={colors.text.muted.dark} />
      </View>
    );
  }

  if (servers.length <= 1) {
    if (servers.length === 1) {
      return (
        <View className="flex-row items-center px-3">
          <Server size={16} color={colors.text.primary.dark} />
          <Text className="ml-2 text-sm font-medium text-white" numberOfLines={1}>
            {servers[0]?.name}
          </Text>
        </View>
      );
    }
    return null;
  }

  const buttonLabel = isMultiServer
    ? `${selectedServerIds.length} ${t('mobile:serverSelector.servers')}`
    : (selectedServers[0]?.name ?? t('mobile:navigation.selectServer'));

  const handleSelect = (serverId: string) => {
    if (multiSelect) {
      toggleServer(serverId);
    } else {
      selectServer(serverId);
      setModalVisible(false);
    }
  };

  return (
    <>
      <TouchableOpacity
        onPress={() => setModalVisible(true)}
        className="flex-row items-center px-3 py-2"
        activeOpacity={0.7}
      >
        <Server size={16} color={ACCENT_COLOR} />
        <Text className="ml-2 text-sm font-medium text-white" numberOfLines={1}>
          {buttonLabel}
        </Text>
        <ChevronDown size={16} color={colors.text.muted.dark} className="ml-1" />
      </TouchableOpacity>

      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <Pressable
          className="flex-1 items-center justify-center bg-black/60"
          onPress={() => setModalVisible(false)}
        >
          <Pressable
            className="w-4/5 max-w-sm overflow-hidden rounded-xl bg-gray-900"
            onPress={(e) => e.stopPropagation()}
          >
            <View className="flex-row items-center justify-between border-b border-gray-800 px-4 py-3">
              <Text className="text-lg font-semibold text-white">
                {multiSelect
                  ? t('mobile:serverSelector.selectServers')
                  : t('mobile:navigation.selectServer')}
              </Text>
              {multiSelect && (
                <TouchableOpacity
                  onPress={() => {
                    if (isAllServersSelected) {
                      selectServer(servers[0]?.id ?? null);
                    } else {
                      selectAllServers();
                    }
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={{ color: ACCENT_COLOR, fontSize: 13, fontWeight: '500' }}>
                    {isAllServersSelected
                      ? t('common:actions.deselectAll')
                      : t('common:actions.selectAll')}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
            <View className="py-2">
              {servers.map((server) => {
                const isSelected = selectedServerIds.includes(server.id);
                return (
                  <TouchableOpacity
                    key={server.id}
                    onPress={() => handleSelect(server.id)}
                    className="relative flex-row items-center py-3"
                    style={{ paddingLeft: 18, paddingRight: 16 }}
                    activeOpacity={0.7}
                  >
                    <View
                      style={{
                        position: 'absolute',
                        left: 6,
                        top: 8,
                        bottom: 8,
                        width: 3,
                        borderRadius: 1.5,
                        backgroundColor: server.color ?? 'transparent',
                      }}
                    />
                    {multiSelect ? (
                      isSelected ? (
                        <SquareCheck size={20} color={ACCENT_COLOR} />
                      ) : (
                        <Square size={20} color={colors.text.muted.dark} />
                      )
                    ) : (
                      isSelected && <Check size={20} color={ACCENT_COLOR} />
                    )}
                    <View className={multiSelect ? 'ml-3 flex-1' : 'ml-3 flex-1'}>
                      <Text
                        className="text-base"
                        style={{
                          fontWeight: isSelected ? '500' : '400',
                          color: isSelected ? (multiSelect ? 'white' : ACCENT_COLOR) : 'white',
                        }}
                        numberOfLines={1}
                      >
                        {server.name}
                      </Text>
                      <Text className="text-xs text-gray-500 capitalize">{server.type}</Text>
                    </View>
                    {!multiSelect && !isSelected && <View style={{ width: 20 }} />}
                  </TouchableOpacity>
                );
              })}
            </View>
            {multiSelect && (
              <View className="border-t border-gray-800 px-4 py-2.5">
                <Text className="text-center text-xs text-gray-500">
                  {t('mobile:serverSelector.serversSelected', {
                    selected: selectedServerIds.length,
                    total: servers.length,
                  })}
                </Text>
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
