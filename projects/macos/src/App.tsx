import {
  AgentClient,
  type ConnectionConfig,
  type ConnectionState,
} from "@pi-in-the-sky/client/agent-client";
import {
  type ActivityRecord,
  type ChatMessage,
  LOCAL_DEV_AUTH_TOKEN,
  type TakeoverRecord,
} from "@pi-in-the-sky/client/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { THEME } from "./theme";

type ActiveTab = "stream" | "memory" | "settings";

type AppState =
  | { readonly kind: "onboarding" }
  | {
      readonly kind: "signed_out_settings";
      readonly config: ConnectionConfig;
    }
  | {
      readonly kind: "active";
      readonly tab: ActiveTab;
      readonly config: ConnectionConfig;
      readonly showDrawer: boolean;
    };

const DEFAULT_CONFIG: ConnectionConfig = {
  baseUrl: "http://127.0.0.1:8787",
  authToken: "",
};

const ACTIVE_TABS: readonly ActiveTab[] = ["stream", "memory", "settings"];

function tabLabel(tab: ActiveTab): string {
  switch (tab) {
    case "stream":
      return "Chat";
    case "memory":
      return "Memory";
    case "settings":
      return "Settings";
    default: {
      tab satisfies never;
      return "";
    }
  }
}

function connectionDotColor(state: ConnectionState): string {
  switch (state) {
    case "connected":
      return THEME.green;
    case "connecting":
      return THEME.orange;
    case "disconnected":
      return THEME.textTertiary;
    default: {
      state satisfies never;
      return THEME.textTertiary;
    }
  }
}

export function App() {
  const [appState, setAppState] = useState<AppState>({ kind: "onboarding" });
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [activeTakeovers, setActiveTakeovers] = useState<TakeoverRecord[]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const sessionEpochRef = useRef(0);

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
    const epoch = sessionEpochRef.current;
    void loadStoredConnectionConfig().then((result) => {
      if (!active || sessionEpochRef.current !== epoch) {
        return;
      }
      if (!result.ok) {
        setErrorBanner(result.error);
        return;
      }
      if (result.value && result.value.authToken.trim().length > 0) {
        client.updateConfig(result.value);
        setAppState({
          kind: "active",
          tab: "stream",
          config: result.value,
          showDrawer: false,
        });
        return;
      }
      if (__DEV__) {
        const devConfig: ConnectionConfig = {
          baseUrl: DEFAULT_CONFIG.baseUrl,
          authToken: LOCAL_DEV_AUTH_TOKEN,
        };
        client.updateConfig(devConfig);
        setAppState({
          kind: "active",
          tab: "stream",
          config: devConfig,
          showDrawer: false,
        });
      }
    });
    return () => {
      active = false;
      client.disconnect();
    };
  }, [client]);

  const applyAndPersistConfig = (
    next: ConnectionConfig,
    expectedEpoch?: number,
  ) => {
    if (
      expectedEpoch !== undefined &&
      sessionEpochRef.current !== expectedEpoch
    ) {
      return;
    }
    setErrorBanner(null);
    client.updateConfig(next);
    setAppState({
      kind: "active",
      tab: "stream",
      config: next,
      showDrawer: false,
    });
    const epoch = sessionEpochRef.current;
    void saveStoredConnectionConfig(next).then((saved) => {
      if (sessionEpochRef.current !== epoch) {
        return;
      }
      if (!saved.ok) {
        setErrorBanner(saved.error);
      }
    });
  };

  const handleSignOut = (currentConfig: ConnectionConfig) => {
    sessionEpochRef.current += 1;
    setErrorBanner(null);
    client.clearSession();
    if (currentConfig.accessTeamDomain && currentConfig.accessClientId) {
      setAppState({
        kind: "signed_out_settings",
        config: {
          baseUrl: currentConfig.baseUrl,
          authToken: "",
          accessTeamDomain: currentConfig.accessTeamDomain,
          accessClientId: currentConfig.accessClientId,
        },
      });
    } else {
      setAppState({ kind: "onboarding" });
    }
    void clearStoredConnectionConfig().then((cleared) => {
      if (!cleared.ok) {
        setErrorBanner(cleared.error);
      }
    });
  };

  const handleOffboard = () => {
    sessionEpochRef.current += 1;
    setErrorBanner(null);
    client.clearSession();
    setAppState({ kind: "onboarding" });
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

  const runningCount = activities.filter(
    (item) => item.status === "running" || item.status === "waiting_input",
  ).length;

  const renderActiveTab = (
    active: Extract<AppState, { readonly kind: "active" }>,
  ) => {
    switch (active.tab) {
      case "stream":
        return (
          <StreamView
            messages={messages}
            activities={activities}
            activeTakeovers={activeTakeovers}
            showDrawer={active.showDrawer}
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
            onAbort={() => client.abort()}
            onResumeTakeover={handleResumeTakeover}
          />
        );
      case "memory":
        return <MemoryPane client={client} />;
      case "settings":
        return (
          <SettingsPane
            config={active.config}
            connectionState={connectionState}
            getSessionEpoch={() => sessionEpochRef.current}
            onSave={applyAndPersistConfig}
            onSignOut={() => handleSignOut(active.config)}
            onOffboard={handleOffboard}
          />
        );
      default: {
        active.tab satisfies never;
        return null;
      }
    }
  };

  const renderContent = (current: AppState) => {
    switch (current.kind) {
      case "onboarding":
        return (
          <OnboardingView onComplete={(next) => applyAndPersistConfig(next)} />
        );
      case "signed_out_settings":
        return (
          <SettingsPane
            config={current.config}
            connectionState={connectionState}
            getSessionEpoch={() => sessionEpochRef.current}
            onSave={applyAndPersistConfig}
            onSignOut={() => handleSignOut(current.config)}
            onOffboard={handleOffboard}
          />
        );
      case "active":
        return renderActiveTab(current);
      default: {
        current satisfies never;
        return null;
      }
    }
  };

  return (
    <SafeAreaView style={styles.root}>
      {appState.kind === "active" ? (
        <View style={styles.toolbar}>
          <Pressable
            style={styles.brand}
            onPress={() => setAppState({ ...appState, tab: "stream" })}
          >
            <View
              style={[
                styles.statusDot,
                { backgroundColor: connectionDotColor(connectionState) },
              ]}
            />
            <Text style={styles.title}>Pi in the Sky</Text>
          </Pressable>

          <View style={styles.segmented}>
            {ACTIVE_TABS.map((tab) => {
              const active = appState.tab === tab;
              return (
                <Pressable
                  key={tab}
                  style={[styles.segment, active && styles.segmentActive]}
                  onPress={() => setAppState({ ...appState, tab })}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      active && styles.segmentTextActive,
                    ]}
                  >
                    {tabLabel(tab)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Pressable
            style={[
              styles.tasksButton,
              appState.showDrawer && styles.tasksButtonActive,
            ]}
            onPress={() =>
              setAppState({
                ...appState,
                tab: "stream",
                showDrawer: !appState.showDrawer,
              })
            }
          >
            <Text
              style={[
                styles.tasksText,
                appState.showDrawer && styles.tasksTextActive,
              ]}
            >
              Tasks{runningCount > 0 ? ` · ${runningCount}` : ""}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {errorBanner ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{errorBanner}</Text>
        </View>
      ) : null}

      <View style={styles.main}>{renderContent(appState)}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: THEME.canvas },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: THEME.border,
    backgroundColor: THEME.toolbar,
  },
  brand: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 120 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  title: {
    color: THEME.textPrimary,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: -0.1,
  },
  segmented: {
    flexDirection: "row",
    backgroundColor: THEME.segmentBg,
    borderRadius: 8,
    padding: 2,
    gap: 2,
  },
  segment: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 6,
  },
  segmentActive: {
    backgroundColor: THEME.surface,
  },
  segmentText: {
    color: THEME.textSecondary,
    fontSize: 12,
    fontWeight: "500",
  },
  segmentTextActive: {
    color: THEME.textPrimary,
    fontWeight: "600",
  },
  tasksButton: {
    minWidth: 72,
    alignItems: "flex-end",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 7,
  },
  tasksButtonActive: {
    backgroundColor: THEME.blueTint,
  },
  tasksText: {
    color: THEME.textSecondary,
    fontSize: 12,
    fontWeight: "500",
  },
  tasksTextActive: {
    color: THEME.blue,
    fontWeight: "600",
  },
  main: { flex: 1 },
  errorBar: {
    backgroundColor: THEME.redTint,
    borderBottomWidth: 1,
    borderBottomColor: "#FFD6D3",
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  errorText: { color: THEME.red, fontSize: 12, fontWeight: "500" },
});
