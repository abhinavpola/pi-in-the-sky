import { useEffect, useMemo, useState } from "react";
import { Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";

import { AgentClient } from "./agent-client";
import { ChatPane } from "./components/ChatPane";
import { MemoryPane } from "./components/MemoryPane";
import { SettingsPane } from "./components/SettingsPane";
import type {
  ChatMessage,
  ConnectionConfig,
  ConnectionState,
  TabId,
  TakeoverItem,
} from "./types";

const DEFAULT_CONFIG: ConnectionConfig = {
  baseUrl: "http://127.0.0.1:8787",
  agentId: "personal",
  authToken: "",
};

const TABS: readonly { readonly id: TabId; readonly label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "memory", label: "Memory" },
  { id: "settings", label: "Settings" },
];

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>("chat");
  const [config, setConfig] = useState<ConnectionConfig>(DEFAULT_CONFIG);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeTakeovers, setActiveTakeovers] = useState<TakeoverItem[]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const client = useMemo(
    () =>
      new AgentClient(DEFAULT_CONFIG, {
        onConnectionChange: setConnectionState,
        onMessagesChange: setMessages,
        onTakeoverRequested: (takeover) => {
          setActiveTakeovers((prev) => [
            ...prev.filter((item) => item.id !== takeover.id),
            takeover,
          ]);
        },
        onReset: () => {
          setActiveTakeovers([]);
        },
        onError: setErrorBanner,
      }),
    [],
  );

  useEffect(() => {
    client.connect();
    return () => {
      client.disconnect();
    };
  }, [client]);

  const handleResumeTakeover = (id: string) => {
    client.resumeTakeover(id);
    setActiveTakeovers((prev) => prev.filter((item) => item.id !== id));
  };

  const renderPane = (tab: TabId) => {
    switch (tab) {
      case "chat":
        return (
          <ChatPane
            messages={messages}
            activeTakeovers={activeTakeovers}
            onSend={(text) => {
              setErrorBanner(null);
              return client.submitPrompt(text);
            }}
            onAbort={() => client.abort()}
            onResumeTakeover={handleResumeTakeover}
          />
        );
      case "memory":
        return <MemoryPane client={client} />;
      case "settings":
        return (
          <SettingsPane
            config={config}
            connectionState={connectionState}
            onSave={(next) => {
              setConfig(next);
              setErrorBanner(null);
              client.updateConfig(next);
            }}
          />
        );
      default: {
        tab satisfies never;
        return null;
      }
    }
  };

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.sidebar}>
        <Text style={styles.title}>Pi in the Sky</Text>
        <Text style={styles.badge}>{connectionState}</Text>
        {TABS.map((tab) => (
          <Pressable
            key={tab.id}
            style={[styles.navItem, activeTab === tab.id && styles.navActive]}
            onPress={() => setActiveTab(tab.id)}
          >
            <Text style={styles.navText}>{tab.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.main}>
        {errorBanner ? (
          <View style={styles.errorBar}>
            <Text style={styles.errorText}>{errorBanner}</Text>
          </View>
        ) : null}
        {renderPane(activeTab)}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: "row", backgroundColor: "#0b1120" },
  sidebar: {
    width: 200,
    backgroundColor: "#0b1120",
    borderRightWidth: 1,
    borderRightColor: "#1e293b",
    padding: 16,
    gap: 8,
  },
  title: { color: "#f8fafc", fontSize: 16, fontWeight: "700" },
  badge: { color: "#93c5fd", fontSize: 12, marginBottom: 12 },
  navItem: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  navActive: { backgroundColor: "#1e293b" },
  navText: { color: "#f8fafc", fontSize: 14, fontWeight: "500" },
  main: { flex: 1 },
  errorBar: { backgroundColor: "#7f1d1d", padding: 8 },
  errorText: { color: "#fecaca", fontSize: 12 },
});
