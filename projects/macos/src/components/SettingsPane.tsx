import type {
  ConnectionConfig,
  ConnectionState,
} from "@pi-in-the-sky/client/agent-client";
import {
  fetchWorkerStatus,
  refreshAccessToken,
} from "@pi-in-the-sky/client/onboarding";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { signInWithCloudflareAccess } from "../native";

type SettingsPaneProps = {
  readonly config: ConnectionConfig;
  readonly connectionState: ConnectionState;
  readonly onSave: (config: ConnectionConfig) => void;
  readonly onSignOut: () => void;
};

export function SettingsPane({
  config,
  connectionState,
  onSave,
  onSignOut,
}: SettingsPaneProps) {
  const [errorText, setErrorText] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleSignIn = async () => {
    setErrorText(null);
    setStatusMessage("Checking Cloudflare Access configuration...");
    const status = await fetchWorkerStatus(config.baseUrl);
    switch (status.kind) {
      case "offline":
        setStatusMessage(null);
        setErrorText(status.reason);
        return;
      case "live_no_oauth":
        setStatusMessage(null);
        setErrorText(
          "Cloudflare Access Managed OAuth is not configured on this Worker.",
        );
        return;
      case "live_oauth_ready": {
        const result = await signInWithCloudflareAccess({
          baseUrl: status.baseUrl,
          teamDomain: status.teamDomain,
          clientId: status.clientId,
          onStatus: setStatusMessage,
        });
        if (!result.ok) {
          setStatusMessage(null);
          setErrorText(result.error);
          return;
        }
        setStatusMessage("Signed in with Cloudflare Access.");
        onSave(result.value);
        return;
      }
      default: {
        status satisfies never;
      }
    }
  };

  const handleRefreshSession = async () => {
    if (
      !config.accessTeamDomain ||
      !config.accessClientId ||
      !config.refreshToken
    ) {
      setErrorText("No refreshable Cloudflare Access session stored.");
      return;
    }
    setErrorText(null);
    setStatusMessage("Refreshing Cloudflare Access JWT...");
    const result = await refreshAccessToken(
      config.accessTeamDomain,
      config.accessClientId,
      config.refreshToken,
    );
    if (!result.ok) {
      setStatusMessage(null);
      setErrorText(result.error);
      return;
    }
    setStatusMessage("Refreshed session token.");
    onSave({
      ...config,
      authToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  };

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Account</Text>
      <Text style={styles.status}>Status: {connectionState}</Text>
      <Text style={styles.meta}>Worker: {config.baseUrl}</Text>
      {config.accessTeamDomain ? (
        <Text style={styles.meta}>
          Cloudflare Access: {config.accessTeamDomain}
        </Text>
      ) : null}

      <View style={styles.row}>
        <Pressable
          style={styles.oauthButton}
          onPress={() => {
            void handleSignIn();
          }}
        >
          <Text style={styles.buttonText}>Sign in with Cloudflare Access</Text>
        </Pressable>
        {config.refreshToken ? (
          <Pressable
            style={styles.refreshButton}
            onPress={() => {
              void handleRefreshSession();
            }}
          >
            <Text style={styles.buttonText}>Refresh Session</Text>
          </Pressable>
        ) : null}
        <Pressable style={styles.signOutButton} onPress={onSignOut}>
          <Text style={styles.buttonText}>Sign Out</Text>
        </Pressable>
      </View>

      {statusMessage ? (
        <Text style={styles.status}>{statusMessage}</Text>
      ) : null}
      {errorText ? <Text style={styles.error}>{errorText}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a", padding: 16, gap: 10 },
  heading: { color: "#f8fafc", fontSize: 16, fontWeight: "700" },
  status: { color: "#93c5fd", fontSize: 13 },
  meta: { color: "#cbd5e1", fontSize: 13 },
  error: { color: "#fca5a5", fontSize: 12 },
  row: { flexDirection: "row", gap: 8, marginTop: 8 },
  oauthButton: {
    backgroundColor: "#0f766e",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  refreshButton: {
    backgroundColor: "#334155",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  signOutButton: {
    backgroundColor: "#991b1b",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  buttonText: { color: "#ffffff", fontSize: 13, fontWeight: "600" },
});
