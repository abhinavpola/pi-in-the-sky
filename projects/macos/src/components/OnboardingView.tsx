import type { ConnectionConfig } from "@pi-in-the-sky/client/agent-client";
import {
  DEPLOY_TO_CLOUDFLARE_URL,
  discoverCloudflareWorker,
  fetchWorkerStatus,
  provisionWorkerSecrets,
} from "@pi-in-the-sky/client/onboarding";
import { LOCAL_DEV_AUTH_TOKEN } from "@pi-in-the-sky/client/protocol";
import { useState } from "react";
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { signInWithCloudflareAccess } from "../native";

type OnboardingStep = "connect" | "deploy" | "access_login";

const LOCAL_DEV_URL = "http://127.0.0.1:8787";

type OnboardingViewProps = {
  readonly onComplete: (config: ConnectionConfig) => void;
};

export function OnboardingView({ onComplete }: OnboardingViewProps) {
  const [step, setStep] = useState<OnboardingStep>("connect");
  const [cfApiToken, setCfApiToken] = useState("");
  const [nearAiApiKey, setNearAiApiKey] = useState("");
  const [workerUrl, setWorkerUrl] = useState("");
  const [teamDomain, setTeamDomain] = useState("");
  const [clientId, setClientId] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const verifyLiveWorker = async (candidateUrl: string) => {
    setStatusMessage("Checking Worker liveness...");
    const status = await fetchWorkerStatus(candidateUrl);
    switch (status.kind) {
      case "offline":
        setStatusMessage(null);
        setErrorText(`Worker not reachable yet: ${status.reason}`);
        setStep("deploy");
        return;
      case "live_no_oauth":
        setStatusMessage(null);
        onComplete({
          baseUrl: status.baseUrl,
          authToken: LOCAL_DEV_AUTH_TOKEN,
        });
        return;
      case "live_oauth_ready":
        setWorkerUrl(status.baseUrl);
        setTeamDomain(status.teamDomain);
        setClientId(status.clientId);
        setStatusMessage("Worker is live and Cloudflare Access is ready.");
        setStep("access_login");
        return;
      default: {
        status satisfies never;
      }
    }
  };

  const handleContinue = async () => {
    if (!cfApiToken.trim() || !nearAiApiKey.trim()) {
      setErrorText(
        "Both your Cloudflare setup token and NEAR AI API key are required.",
      );
      return;
    }
    setErrorText(null);
    setStatusMessage("Discovering your Cloudflare account and Worker...");
    const discovery = await discoverCloudflareWorker(cfApiToken);
    switch (discovery.kind) {
      case "found": {
        setStatusMessage("Uploading NEAR AI secret to your Worker...");
        const provisioned = await provisionWorkerSecrets(
          cfApiToken,
          discovery.accountId,
          nearAiApiKey,
        );
        if (!provisioned.ok) {
          setStatusMessage(null);
          setErrorText(`Secret provisioning failed: ${provisioned.error}`);
          return;
        }
        setCfApiToken("");
        setNearAiApiKey("");
        setWorkerUrl(discovery.baseUrl);
        await verifyLiveWorker(discovery.baseUrl);
        return;
      }
      case "not_deployed":
        setStatusMessage(
          "No pi-in-the-sky Worker found on your account yet. Deploy it in 1 click below.",
        );
        setStep("deploy");
        return;
      case "error":
        setStatusMessage(null);
        setErrorText(discovery.message);
        return;
      default: {
        discovery satisfies never;
      }
    }
  };

  const handleOpenDeploy = async () => {
    setErrorText(null);
    await Linking.openURL(DEPLOY_TO_CLOUDFLARE_URL);
    setStatusMessage(
      "Opened Deploy to Cloudflare in your browser. Once finished, click Continue.",
    );
  };

  const handleAccessLogin = async () => {
    setErrorText(null);
    const result = await signInWithCloudflareAccess({
      baseUrl: workerUrl,
      teamDomain,
      clientId,
      onStatus: setStatusMessage,
    });
    if (!result.ok) {
      setStatusMessage(null);
      setErrorText(result.error);
      return;
    }
    setStatusMessage(null);
    onComplete(result.value);
  };

  const renderStep = (current: OnboardingStep) => {
    switch (current) {
      case "connect":
        return (
          <View style={styles.card}>
            <Text style={styles.stepTitle}>1. Connect Cloudflare</Text>
            <Text style={styles.desc}>
              Your account, Worker URL, and Access login are derived
              automatically. Your setup token is discarded immediately after
              provisioning.
            </Text>
            <Text style={styles.label}>Cloudflare Setup Token</Text>
            <TextInput
              style={styles.input}
              value={cfApiToken}
              onChangeText={setCfApiToken}
              secureTextEntry
              placeholder="Cloudflare API token"
              placeholderTextColor="#64748b"
            />
            <Text style={styles.label}>NEAR AI API Key</Text>
            <TextInput
              style={styles.input}
              value={nearAiApiKey}
              onChangeText={setNearAiApiKey}
              secureTextEntry
              placeholder="sk-..."
              placeholderTextColor="#64748b"
            />
            <Pressable
              style={styles.primaryButton}
              onPress={() => {
                void handleContinue();
              }}
            >
              <Text style={styles.buttonText}>Continue</Text>
            </Pressable>
          </View>
        );
      case "deploy":
        return (
          <View style={styles.card}>
            <Text style={styles.stepTitle}>
              2. 1-Click Deploy to Cloudflare
            </Text>
            <Text style={styles.desc}>
              Deploy your private pi-in-the-sky Worker to your Cloudflare
              account, then continue to configure secrets and sign in.
            </Text>
            <View style={styles.row}>
              <Pressable
                style={styles.deployButton}
                onPress={() => {
                  void handleOpenDeploy();
                }}
              >
                <Text style={styles.buttonText}>Deploy to Cloudflare</Text>
              </Pressable>
              <Pressable
                style={styles.primaryButton}
                onPress={() => {
                  void handleContinue();
                }}
              >
                <Text style={styles.buttonText}>Continue</Text>
              </Pressable>
            </View>
          </View>
        );
      case "access_login":
        return (
          <View style={styles.card}>
            <Text style={styles.stepTitle}>
              3. Sign in with Cloudflare Access
            </Text>
            <Text style={styles.desc}>
              Worker: {workerUrl} ({teamDomain})
            </Text>
            <Pressable
              style={styles.oauthButton}
              onPress={() => {
                void handleAccessLogin();
              }}
            >
              <Text style={styles.buttonText}>
                Sign in with Cloudflare Access
              </Text>
            </Pressable>
          </View>
        );
      default: {
        current satisfies never;
        return null;
      }
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Pi in the Sky</Text>
      <Text style={styles.subtitle}>
        Private personal AI running durably on your Cloudflare account.
      </Text>

      {renderStep(step)}

      {statusMessage ? (
        <Text style={styles.status}>{statusMessage}</Text>
      ) : null}
      {errorText ? <Text style={styles.error}>{errorText}</Text> : null}

      <Pressable
        style={styles.localLink}
        onPress={() => {
          void verifyLiveWorker(LOCAL_DEV_URL);
        }}
      >
        <Text style={styles.localText}>Use local dev Worker</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
    padding: 24,
    justifyContent: "center",
    gap: 12,
  },
  title: { color: "#f8fafc", fontSize: 24, fontWeight: "700" },
  subtitle: { color: "#94a3b8", fontSize: 13, marginBottom: 8 },
  card: {
    backgroundColor: "#1e293b",
    borderRadius: 12,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: "#334155",
  },
  stepTitle: { color: "#f8fafc", fontSize: 16, fontWeight: "700" },
  desc: { color: "#cbd5e1", fontSize: 12 },
  label: { color: "#cbd5e1", fontSize: 12, fontWeight: "600", marginTop: 4 },
  input: {
    backgroundColor: "#0f172a",
    color: "#f8fafc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
  },
  row: { flexDirection: "row", gap: 8, marginTop: 6 },
  primaryButton: {
    backgroundColor: "#2563eb",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: "flex-start",
    marginTop: 4,
  },
  deployButton: {
    backgroundColor: "#ea580c",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: "flex-start",
    marginTop: 4,
  },
  oauthButton: {
    backgroundColor: "#0f766e",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  buttonText: { color: "#ffffff", fontSize: 13, fontWeight: "600" },
  status: { color: "#93c5fd", fontSize: 12 },
  error: { color: "#fca5a5", fontSize: 12 },
  localLink: { alignSelf: "flex-start", marginTop: 8 },
  localText: { color: "#64748b", fontSize: 12 },
});
