import {
  type ConnectionConfig,
  type ConnectionState,
  validateBaseUrl,
} from "@pi-in-the-sky/client/agent-client";
import {
  fetchWorkerStatus,
  refreshAccessToken,
} from "@pi-in-the-sky/client/onboarding";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

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
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [authToken, setAuthToken] = useState(config.authToken);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleSave = () => {
    const validated = validateBaseUrl(baseUrl);
    if (!validated.ok) {
      setValidationError(validated.error);
      return;
    }
    setValidationError(null);
    const urlChanged = validated.value !== config.baseUrl;
    onSave({
      ...(urlChanged
        ? {}
        : {
            refreshToken: config.refreshToken,
            accessTeamDomain: config.accessTeamDomain,
            accessClientId: config.accessClientId,
          }),
      baseUrl: validated.value,
      authToken: authToken.trim(),
    });
  };

  const handleSignIn = async () => {
    const validated = validateBaseUrl(baseUrl);
    if (!validated.ok) {
      setValidationError(validated.error);
      return;
    }
    setValidationError(null);
    setStatusMessage("Checking Cloudflare Access OAuth configuration...");
    const status = await fetchWorkerStatus(validated.value);
    switch (status.kind) {
      case "offline":
        setStatusMessage(null);
        setValidationError(status.reason);
        return;
      case "live_no_oauth":
        setStatusMessage(null);
        setValidationError(
          "Cloudflare Access Managed OAuth is not configured on this Worker yet.",
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
          setValidationError(result.error);
          return;
        }
        setAuthToken(result.value.authToken);
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
      setValidationError("No refreshable Cloudflare Access session stored.");
      return;
    }
    setValidationError(null);
    setStatusMessage("Refreshing Cloudflare Access JWT...");
    const result = await refreshAccessToken(
      config.accessTeamDomain,
      config.accessClientId,
      config.refreshToken,
    );
    if (!result.ok) {
      setStatusMessage(null);
      setValidationError(result.error);
      return;
    }
    setAuthToken(result.accessToken);
    setStatusMessage("Refreshed session token.");
    onSave({
      ...config,
      authToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  };

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Agent Connection</Text>
      <Text style={styles.status}>Status: {connectionState}</Text>

      <Text style={styles.label}>Worker Base URL</Text>
      <TextInput
        style={styles.input}
        value={baseUrl}
        onChangeText={setBaseUrl}
        placeholder="https://agent.example.com"
        placeholderTextColor="#6b7280"
      />

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
      </View>

      <Text style={styles.label}>Access JWT or Local Dev Token</Text>
      <TextInput
        style={styles.input}
        value={authToken}
        onChangeText={setAuthToken}
        secureTextEntry
        placeholder="Cloudflare Access JWT or local AUTH_TOKEN"
        placeholderTextColor="#6b7280"
      />

      {statusMessage ? (
        <Text style={styles.status}>{statusMessage}</Text>
      ) : null}

      {validationError ? (
        <Text style={styles.error}>{validationError}</Text>
      ) : null}

      <View style={styles.row}>
        <Pressable style={styles.button} onPress={handleSave}>
          <Text style={styles.buttonText}>Save & Reconnect</Text>
        </Pressable>
        <Pressable style={styles.signOutButton} onPress={onSignOut}>
          <Text style={styles.buttonText}>Sign Out</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a", padding: 16, gap: 10 },
  heading: { color: "#f8fafc", fontSize: 16, fontWeight: "700" },
  status: { color: "#93c5fd", fontSize: 13 },
  error: { color: "#fca5a5", fontSize: 12 },
  label: { color: "#cbd5e1", fontSize: 12, fontWeight: "600", marginTop: 6 },
  input: {
    backgroundColor: "#1e293b",
    color: "#f8fafc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
  },
  row: { flexDirection: "row", gap: 8, marginTop: 4 },
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
  button: {
    backgroundColor: "#2563eb",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: "flex-start",
    marginTop: 8,
  },
  signOutButton: {
    backgroundColor: "#991b1b",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: "flex-start",
    marginTop: 8,
  },
  buttonText: { color: "#ffffff", fontSize: 13, fontWeight: "600" },
});
