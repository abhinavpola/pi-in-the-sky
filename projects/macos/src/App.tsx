import {
  AgentClient,
  type ConnectionConfig,
  type ConnectionState,
} from "@pi-in-the-sky/client/agent-client";
import type {
  ActivityRecord,
  ChatMessage,
  TakeoverRecord,
} from "@pi-in-the-sky/client/protocol";
import { useEffect, useMemo, useState } from "react";
import { Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";

import { MemoryPane } from "./components/MemoryPane";
import { OnboardingView } from "./components/OnboardingView";
import { SettingsPane } from "./components/SettingsPane";
import { StreamView } from "./components/StreamView";
import {
  clearStoredConnectionConfig,
  loadStoredConnectionConfig,
  saveStoredConnectionConfig,
} from "./native";

type ViewMode = "onboarding" | "stream" | "memory" | "settings";

const DEFAULT_CONFIG: ConnectionConfig = {
  baseUrl: "http://127.0.0.1:8787",
  authToken: "",
};

export function App() {
  const [viewMode, setViewMode] = useState<ViewMode>("onboarding");
  const [showDrawer, setShowDrawer] = useState(false);
  const [config, setConfig] = useState<ConnectionConfig>(DEFAULT_CONFIG);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [activeTakeovers, setActiveTakeovers] = useState<TakeoverRecord[]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const client = useMemo(
    () =>
      new AgentClient(DEFAULT_CONFIG, {
        onConnectionChange: setConnectionState,
        onMessagesChange: setMessages,
        onActivitiesChange: setActivities,
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
        createSocket: (url, headers) => new WebSocket(url, null, { headers }),
      }),
    [],
  );

  useEffect(() => {
    let active = true;
    void loadStoredConnectionConfig().then((result) => {
      if (!active) {
        return;
      }
      if (!result.ok) {
        setErrorBanner(result.error);
        client.connect();
        return;
      }
      if (result.value) {
        setConfig(result.value);
        client.updateConfig(result.value);
        if (result.value.authToken.trim().length > 0) {
          setViewMode("stream");
        }
        return;
      }
      client.connect();
    });
    return () => {
      active = false;
      client.disconnect();
    };
  }, [client]);

  const applyAndPersistConfig = (next: ConnectionConfig) => {
    setConfig(next);
    setErrorBanner(null);
    client.updateConfig(next);
    setViewMode("stream");
    void saveStoredConnectionConfig(next).then((saved) => {
      if (!saved.ok) {
        setErrorBanner(saved.error);
      }
    });
  };

  const handleSignOut = () => {
    setConfig(DEFAULT_CONFIG);
    setErrorBanner(null);
    client.updateConfig(DEFAULT_CONFIG);
    setViewMode("onboarding");
    void clearStoredConnectionConfig().then((cleared) => {
      if (!cleared.ok) {
        setErrorBanner(cleared.error);
      }
    });
  };

  const handleResumeTakeover = (id: string) => {
    client.resumeTakeover(id);
    setActiveTakeovers((prev) => prev.filter((item) => item.id !== id));
  };

  const handleCompact = () => {
    const recent = messages
      .slice(-6)
      .map((item) => `${item.role}: ${item.text}`)
      .join(" | ");
    const summary = recent || "Compacted stream checkpoint.";
    client.compactThread(summary);
  };

  const runningCount = activities.filter(
    (item) => item.status === "running" || item.status === "waiting_input",
  ).length;

  const renderContent = (mode: ViewMode) => {
    switch (mode) {
      case "onboarding":
        return <OnboardingView onComplete={applyAndPersistConfig} />;
      case "stream":
        return (
          <StreamView
            messages={messages}
            activities={activities}
            activeTakeovers={activeTakeovers}
            showDrawer={showDrawer}
            onSend={(text) => {
              setErrorBanner(null);
              return client.submitPrompt(text);
            }}
            onSteerActivity={(activityId, instruction) => {
              setErrorBanner(null);
              return client.steerActivity(activityId, instruction);
            }}
            onToggleActivity={(activityId, collapsed) => {
              client.toggleActivity(activityId, collapsed);
            }}
            onCompact={handleCompact}
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
            onSave={applyAndPersistConfig}
            onSignOut={handleSignOut}
          />
        );
      default: {
        mode satisfies never;
        return null;
      }
    }
  };

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Pressable onPress={() => setViewMode("stream")}>
            <Text style={styles.title}>Pi in the Sky</Text>
          </Pressable>
          <Text style={styles.badge}>{connectionState}</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            style={[styles.pill, showDrawer && styles.pillActive]}
            onPress={() => {
              setViewMode("stream");
              setShowDrawer((prev) => !prev);
            }}
          >
            <Text style={styles.pillText}>
              Activity{runningCount > 0 ? ` (${runningCount})` : ""}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.pill, viewMode === "memory" && styles.pillActive]}
            onPress={() =>
              setViewMode((prev) => (prev === "memory" ? "stream" : "memory"))
            }
          >
            <Text style={styles.pillText}>Memory</Text>
          </Pressable>
          <Pressable
            style={[
              styles.pill,
              viewMode === "onboarding" && styles.pillActive,
            ]}
            onPress={() =>
              setViewMode((prev) =>
                prev === "onboarding" ? "stream" : "onboarding",
              )
            }
          >
            <Text style={styles.pillText}>Setup</Text>
          </Pressable>
          <Pressable
            style={[styles.pill, viewMode === "settings" && styles.pillActive]}
            onPress={() =>
              setViewMode((prev) =>
                prev === "settings" ? "stream" : "settings",
              )
            }
          >
            <Text style={styles.pillText}>Settings</Text>
          </Pressable>
        </View>
      </View>
      {errorBanner ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{errorBanner}</Text>
        </View>
      ) : null}
      <View style={styles.main}>{renderContent(viewMode)}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b1120" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
    backgroundColor: "#0b1120",
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  headerActions: { flexDirection: "row", gap: 8 },
  title: { color: "#f8fafc", fontSize: 15, fontWeight: "700" },
  badge: { color: "#93c5fd", fontSize: 12 },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#1e293b",
  },
  pillActive: { backgroundColor: "#1d4ed8" },
  pillText: { color: "#f8fafc", fontSize: 12, fontWeight: "600" },
  main: { flex: 1 },
  errorBar: { backgroundColor: "#7f1d1d", padding: 8 },
  errorText: { color: "#fecaca", fontSize: 12 },
});
