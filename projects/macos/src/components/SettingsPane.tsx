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
import { THEME } from "../theme";

type SettingsPaneProps = {
  readonly config: ConnectionConfig;
  readonly connectionState: ConnectionState;
  readonly getSessionEpoch: () => number;
  readonly onSave: (config: ConnectionConfig, expectedEpoch?: number) => void;
  readonly onSignOut: () => void;
};

export function SettingsPane({
  config,
  connectionState,
  getSessionEpoch,
  onSave,
  onSignOut,
}: SettingsPaneProps) {
  const [errorText, setErrorText] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleSignIn = async () => {
    const epoch = getSessionEpoch();
    setErrorText(null);
    setStatusMessage("Connecting...");
    const status = await fetchWorkerStatus(config.baseUrl);
    switch (status.kind) {
      case "offline":
        setStatusMessage(null);
        setErrorText(status.reason);
        return;
      case "live_no_oauth":
        setStatusMessage(null);
        setErrorText("Cloudflare Access is not configured.");
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
        setStatusMessage(null);
        onSave(result.value, epoch);
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
      return;
    }
    const epoch = getSessionEpoch();
    setErrorText(null);
    setStatusMessage("Refreshing...");
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
    setStatusMessage(null);
    onSave(
      {
        ...config,
        authToken: result.accessToken,
        refreshToken: result.refreshToken,
      },
      epoch,
    );
  };

  const isSignedIn =
    config.authToken.trim().length > 0 && connectionState !== "disconnected";

  return (
    <View style={styles.container}>
      <View style={styles.column}>
        <Text style={styles.sectionTitle}>Account</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Status</Text>
            <Text style={styles.rowValue}>{connectionState}</Text>
          </View>
          <View style={[styles.row, styles.rowBorder]}>
            <Text style={styles.rowLabel}>Server</Text>
            <Text style={styles.rowValue}>{config.baseUrl}</Text>
          </View>
          {config.accessTeamDomain ? (
            <View style={[styles.row, styles.rowBorder]}>
              <Text style={styles.rowLabel}>Cloudflare Access</Text>
              <Text style={styles.rowValue}>{config.accessTeamDomain}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.actions}>
          {isSignedIn ? (
            <>
              {config.refreshToken ? (
                <Pressable
                  style={styles.secondaryButton}
                  onPress={() => {
                    void handleRefreshSession();
                  }}
                >
                  <Text style={styles.secondaryButtonText}>Refresh</Text>
                </Pressable>
              ) : null}
              <Pressable style={styles.destructiveButton} onPress={onSignOut}>
                <Text style={styles.destructiveButtonText}>Sign Out</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              style={styles.primaryButton}
              onPress={() => {
                void handleSignIn();
              }}
            >
              <Text style={styles.primaryButtonText}>Sign In</Text>
            </Pressable>
          )}
        </View>

        {errorText ? (
          <Text style={styles.error}>{errorText}</Text>
        ) : statusMessage ? (
          <Text style={styles.status}>{statusMessage}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.canvas,
    padding: 28,
    alignItems: "center",
  },
  column: { width: "100%", maxWidth: 520, gap: 14 },
  sectionTitle: {
    color: THEME.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    paddingHorizontal: 4,
  },
  card: {
    backgroundColor: THEME.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.border,
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: THEME.border,
  },
  rowLabel: { color: THEME.textSecondary, fontSize: 13 },
  rowValue: { color: THEME.textPrimary, fontSize: 13, fontWeight: "500" },
  actions: { flexDirection: "row", gap: 8, marginTop: 4 },
  primaryButton: {
    backgroundColor: THEME.blue,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  primaryButtonText: { color: THEME.white, fontSize: 13, fontWeight: "600" },
  secondaryButton: {
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.borderStrong,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  secondaryButtonText: {
    color: THEME.textPrimary,
    fontSize: 13,
    fontWeight: "500",
  },
  destructiveButton: {
    backgroundColor: THEME.redTint,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  destructiveButtonText: {
    color: THEME.red,
    fontSize: 13,
    fontWeight: "600",
  },
  status: { color: THEME.textSecondary, fontSize: 12 },
  error: { color: THEME.red, fontSize: 12 },
});
