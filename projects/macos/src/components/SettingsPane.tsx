import type {
  ConnectionConfig,
  ConnectionState,
} from "@pi-in-the-sky/client/agent-client";
import {
  type CloudflareDeviceAuth,
  pollCloudflareDeviceToken,
  startCloudflareDeviceAuth,
} from "@pi-in-the-sky/client/cloudflare-device-auth";
import { destroyCloudflareWorker } from "@pi-in-the-sky/client/cloudflare-worker-api";
import {
  discoverCloudflareWorker,
  fetchWorkerStatus,
  refreshAccessToken,
} from "@pi-in-the-sky/client/onboarding";
import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { signInWithCloudflareAccess } from "../native";
import { THEME } from "../theme";

type SettingsPaneProps = {
  readonly config: ConnectionConfig;
  readonly connectionState: ConnectionState;
  readonly getSessionEpoch: () => number;
  readonly onSave: (config: ConnectionConfig, expectedEpoch?: number) => void;
  readonly onSignOut: () => void;
  readonly onOffboard: () => void;
};

export function SettingsPane({
  config,
  connectionState,
  getSessionEpoch,
  onSave,
  onSignOut,
  onOffboard,
}: SettingsPaneProps) {
  const [errorText, setErrorText] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [destroyAuth, setDestroyAuth] = useState<CloudflareDeviceAuth | null>(
    null,
  );
  const destroyAbortRef = useRef<AbortController | null>(null);
  const destroyEpochRef = useRef(0);

  useEffect(() => {
    return () => {
      destroyEpochRef.current += 1;
      destroyAbortRef.current?.abort();
    };
  }, []);

  const cancelDestroy = () => {
    destroyEpochRef.current += 1;
    destroyAbortRef.current?.abort();
    destroyAbortRef.current = null;
    setDestroyAuth(null);
    setStatusMessage(null);
  };

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

  const handleDestroyWorker = async () => {
    if (statusMessage !== null) {
      return;
    }
    destroyEpochRef.current += 1;
    const epoch = destroyEpochRef.current;
    setErrorText(null);
    setStatusMessage("Starting Cloudflare approval...");
    const started = await startCloudflareDeviceAuth();
    if (destroyEpochRef.current !== epoch) {
      return;
    }
    if (!started.ok) {
      setStatusMessage(null);
      setErrorText(started.error);
      return;
    }
    destroyAbortRef.current?.abort();
    const controller = new AbortController();
    destroyAbortRef.current = controller;
    setDestroyAuth(started.value);
    setStatusMessage("Approve in Cloudflare to destroy Worker...");
    await Linking.openURL(started.value.verificationUriComplete);

    const polled = await pollCloudflareDeviceToken(
      started.value,
      controller.signal,
    );
    if (controller.signal.aborted || destroyEpochRef.current !== epoch) {
      return;
    }
    setDestroyAuth(null);
    if (!polled.ok) {
      setStatusMessage(null);
      setErrorText(polled.error);
      return;
    }
    setStatusMessage("Locating Worker...");
    const discovery = await discoverCloudflareWorker(polled.accessToken);
    if (destroyEpochRef.current !== epoch) {
      return;
    }
    switch (discovery.kind) {
      case "error":
        setStatusMessage(null);
        setErrorText(discovery.message);
        return;
      case "not_deployed":
        setStatusMessage(null);
        onOffboard();
        return;
      case "found": {
        const normalizedBaseUrl = config.baseUrl.trim().replace(/\/$/, "");
        const target = discovery.matches.find(
          (item) =>
            item.baseUrl.trim().replace(/\/$/, "") === normalizedBaseUrl,
        );
        if (!target) {
          setStatusMessage(null);
          setErrorText("No deployed Worker matched this server URL.");
          return;
        }
        setStatusMessage(`Destroying Worker in ${target.accountName}...`);
        const destroyed = await destroyCloudflareWorker(
          polled.accessToken,
          target.accountId,
        );
        if (destroyEpochRef.current !== epoch) {
          return;
        }
        if (!destroyed.ok) {
          setStatusMessage(null);
          setErrorText(destroyed.error);
          return;
        }
        setStatusMessage(null);
        onOffboard();
        return;
      }
      default: {
        discovery satisfies never;
      }
    }
  };

  const isSignedIn = config.authToken.trim().length > 0;
  const isBusy = statusMessage !== null;

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
                  disabled={isBusy}
                  onPress={() => {
                    void handleRefreshSession();
                  }}
                >
                  <Text style={styles.secondaryButtonText}>Refresh</Text>
                </Pressable>
              ) : null}
              <Pressable
                style={styles.secondaryButton}
                disabled={isBusy}
                onPress={onSignOut}
              >
                <Text style={styles.secondaryButtonText}>Sign Out</Text>
              </Pressable>
              <Pressable
                style={styles.destructiveButton}
                disabled={isBusy}
                onPress={() => {
                  void handleDestroyWorker();
                }}
              >
                <Text style={styles.destructiveButtonText}>Destroy Worker</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              style={styles.primaryButton}
              disabled={isBusy}
              onPress={() => {
                void handleSignIn();
              }}
            >
              <Text style={styles.primaryButtonText}>Sign In</Text>
            </Pressable>
          )}
        </View>

        {destroyAuth ? (
          <View style={styles.verifyCard}>
            <Text style={styles.verifyTitle}>Approve in Cloudflare</Text>
            <Text style={styles.verifyCode}>{destroyAuth.userCode}</Text>
            <View style={styles.actions}>
              <Pressable
                style={styles.secondaryButton}
                onPress={() => {
                  void Linking.openURL(destroyAuth.verificationUriComplete);
                }}
              >
                <Text style={styles.secondaryButtonText}>Open Cloudflare</Text>
              </Pressable>
              <Pressable style={styles.secondaryButton} onPress={cancelDestroy}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

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
  verifyCard: {
    backgroundColor: THEME.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.border,
    padding: 16,
    gap: 10,
  },
  verifyTitle: { color: THEME.textPrimary, fontSize: 14, fontWeight: "600" },
  verifyCode: {
    color: THEME.textPrimary,
    fontSize: 20,
    fontWeight: "600",
    letterSpacing: 3,
  },
  status: { color: THEME.textSecondary, fontSize: 12 },
  error: { color: THEME.red, fontSize: 12 },
});
