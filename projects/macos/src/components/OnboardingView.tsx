import type { ConnectionConfig } from "@pi-in-the-sky/client/agent-client";
import {
  type CloudflareDeviceAuth,
  pollCloudflareDeviceToken,
  startCloudflareDeviceAuth,
} from "@pi-in-the-sky/client/cloudflare-device-auth";
import {
  DEPLOY_TO_CLOUDFLARE_URL,
  discoverCloudflareWorker,
  fetchWorkerStatus,
  provisionWorkerSecrets,
} from "@pi-in-the-sky/client/onboarding";
import { LOCAL_DEV_AUTH_TOKEN } from "@pi-in-the-sky/client/protocol";
import { useEffect, useRef, useState } from "react";
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { signInWithCloudflareAccess } from "../native";
import { THEME } from "../theme";

type OnboardingStep = "connect" | "cf_verify" | "deploy" | "access_login";

type OnboardingViewProps = {
  readonly onComplete: (config: ConnectionConfig) => void;
};

export function OnboardingView({ onComplete }: OnboardingViewProps) {
  const [step, setStep] = useState<OnboardingStep>("connect");
  const [nearAiApiKey, setNearAiApiKey] = useState("");
  const [cfAccessToken, setCfAccessToken] = useState("");
  const [deviceAuth, setDeviceAuth] = useState<CloudflareDeviceAuth | null>(
    null,
  );
  const [workerUrl, setWorkerUrl] = useState("");
  const [teamDomain, setTeamDomain] = useState("");
  const [clientId, setClientId] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      pollAbortRef.current?.abort();
    };
  }, []);

  const verifyLiveWorker = async (candidateUrl: string) => {
    setStatusMessage("Connecting...");
    const status = await fetchWorkerStatus(candidateUrl);
    switch (status.kind) {
      case "offline":
        setStatusMessage(null);
        setErrorText(status.reason);
        setStep("deploy");
        return;
      case "live_no_oauth":
        setCfAccessToken("");
        setNearAiApiKey("");
        setStatusMessage(null);
        onComplete({
          baseUrl: status.baseUrl,
          authToken: LOCAL_DEV_AUTH_TOKEN,
        });
        return;
      case "live_oauth_ready":
        setCfAccessToken("");
        setNearAiApiKey("");
        setWorkerUrl(status.baseUrl);
        setTeamDomain(status.teamDomain);
        setClientId(status.clientId);
        setStatusMessage(null);
        setStep("access_login");
        return;
      default: {
        status satisfies never;
      }
    }
  };

  const discoverAndConfigure = async (token: string) => {
    setErrorText(null);
    setStatusMessage("Checking Cloudflare...");
    const discovery = await discoverCloudflareWorker(token);
    switch (discovery.kind) {
      case "found": {
        setStatusMessage("Configuring...");
        const provisioned = await provisionWorkerSecrets(
          token,
          discovery.accountId,
          nearAiApiKey,
        );
        if (!provisioned.ok) {
          setStatusMessage(null);
          setErrorText(provisioned.error);
          setStep("connect");
          return;
        }
        setWorkerUrl(discovery.baseUrl);
        await verifyLiveWorker(discovery.baseUrl);
        return;
      }
      case "not_deployed":
        setStatusMessage(null);
        setStep("deploy");
        return;
      case "error":
        setStatusMessage(null);
        setErrorText(discovery.message);
        setStep("connect");
        return;
      default: {
        discovery satisfies never;
      }
    }
  };

  const handleSignInWithCloudflare = async () => {
    if (!nearAiApiKey.trim()) {
      setErrorText("Enter your NEAR AI key to continue.");
      return;
    }
    setErrorText(null);
    setStatusMessage("Starting Cloudflare sign-in...");
    const started = await startCloudflareDeviceAuth();
    if (!started.ok) {
      setStatusMessage(null);
      setErrorText(started.error);
      return;
    }
    pollAbortRef.current?.abort();
    const controller = new AbortController();
    pollAbortRef.current = controller;
    setDeviceAuth(started.value);
    setStatusMessage("Waiting for approval...");
    setStep("cf_verify");
    await Linking.openURL(started.value.verificationUriComplete);

    const polled = await pollCloudflareDeviceToken(
      started.value,
      controller.signal,
    );
    if (controller.signal.aborted) {
      return;
    }
    if (!polled.ok) {
      setStatusMessage(null);
      setErrorText(polled.error);
      setStep("connect");
      return;
    }
    setCfAccessToken(polled.accessToken);
    await discoverAndConfigure(polled.accessToken);
  };

  const handleCancelVerify = () => {
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    setDeviceAuth(null);
    setStatusMessage(null);
    setErrorText(null);
    setStep("connect");
  };

  const handleOpenDeploy = async () => {
    setErrorText(null);
    await Linking.openURL(DEPLOY_TO_CLOUDFLARE_URL);
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
            <View style={styles.field}>
              <Text style={styles.label}>NEAR AI Key</Text>
              <TextInput
                style={styles.input}
                value={nearAiApiKey}
                onChangeText={setNearAiApiKey}
                secureTextEntry
                placeholder="sk-..."
                placeholderTextColor={THEME.textTertiary}
              />
            </View>
            <Pressable
              style={styles.primaryButton}
              onPress={() => {
                void handleSignInWithCloudflare();
              }}
            >
              <Text style={styles.primaryButtonText}>
                Sign in with Cloudflare
              </Text>
            </Pressable>
          </View>
        );
      case "cf_verify":
        return (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Approve in Browser</Text>
            <Text style={styles.cardBody}>
              Confirm this code in Cloudflare to continue.
            </Text>
            {deviceAuth ? (
              <View style={styles.codeBox}>
                <Text style={styles.codeText}>{deviceAuth.userCode}</Text>
              </View>
            ) : null}
            {deviceAuth ? (
              <Pressable
                style={styles.secondaryButton}
                onPress={() => {
                  void Linking.openURL(deviceAuth.verificationUriComplete);
                }}
              >
                <Text style={styles.secondaryButtonText}>Open Cloudflare</Text>
              </Pressable>
            ) : null}
            <Pressable style={styles.localLink} onPress={handleCancelVerify}>
              <Text style={styles.localText}>Cancel</Text>
            </Pressable>
          </View>
        );
      case "deploy":
        return (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Deploy to Cloudflare</Text>
            <Text style={styles.cardBody}>
              Finish deploying in your browser, then continue.
            </Text>
            <Pressable
              style={styles.primaryButton}
              onPress={() => {
                void handleOpenDeploy();
              }}
            >
              <Text style={styles.primaryButtonText}>Deploy to Cloudflare</Text>
            </Pressable>
            <Pressable
              style={styles.secondaryButton}
              onPress={() => {
                void discoverAndConfigure(cfAccessToken);
              }}
            >
              <Text style={styles.secondaryButtonText}>Continue</Text>
            </Pressable>
            <Pressable
              style={styles.localLink}
              onPress={() => {
                setErrorText(null);
                setStep("connect");
              }}
            >
              <Text style={styles.localText}>Back</Text>
            </Pressable>
          </View>
        );
      case "access_login":
        return (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Sign In</Text>
            <Text style={styles.cardBody}>{teamDomain}</Text>
            <Pressable
              style={styles.primaryButton}
              onPress={() => {
                void handleAccessLogin();
              }}
            >
              <Text style={styles.primaryButtonText}>
                Sign in with Cloudflare
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
      <View style={styles.frame}>
        <View style={styles.header}>
          <Text style={styles.title}>Pi in the Sky</Text>
          <Text style={styles.subtitle}>Set up your personal assistant</Text>
        </View>

        {renderStep(step)}

        {statusMessage ? (
          <Text style={styles.status}>{statusMessage}</Text>
        ) : null}
        {errorText ? <Text style={styles.error}>{errorText}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.canvas,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  frame: {
    width: "100%",
    maxWidth: 380,
    gap: 16,
  },
  header: {
    alignItems: "center",
    gap: 4,
    marginBottom: 4,
  },
  title: {
    color: THEME.textPrimary,
    fontSize: 26,
    fontWeight: "600",
    letterSpacing: -0.4,
  },
  subtitle: {
    color: THEME.textSecondary,
    fontSize: 14,
  },
  card: {
    backgroundColor: THEME.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: THEME.border,
    padding: 20,
    gap: 14,
  },
  cardTitle: {
    color: THEME.textPrimary,
    fontSize: 16,
    fontWeight: "600",
  },
  cardBody: {
    color: THEME.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  codeBox: {
    backgroundColor: THEME.inputBg,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  codeText: {
    color: THEME.textPrimary,
    fontSize: 22,
    fontWeight: "600",
    letterSpacing: 3,
  },
  field: {
    gap: 6,
  },
  label: {
    color: THEME.textPrimary,
    fontSize: 13,
    fontWeight: "500",
  },
  input: {
    backgroundColor: THEME.inputBg,
    color: THEME.textPrimary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  primaryButton: {
    backgroundColor: THEME.blue,
    borderRadius: 9,
    paddingVertical: 11,
    alignItems: "center",
    marginTop: 2,
  },
  primaryButtonText: {
    color: THEME.white,
    fontSize: 14,
    fontWeight: "600",
  },
  secondaryButton: {
    backgroundColor: THEME.inputBg,
    borderRadius: 9,
    paddingVertical: 11,
    alignItems: "center",
  },
  secondaryButtonText: {
    color: THEME.textPrimary,
    fontSize: 14,
    fontWeight: "500",
  },
  status: {
    color: THEME.textSecondary,
    fontSize: 13,
    textAlign: "center",
  },
  error: {
    color: THEME.red,
    fontSize: 13,
    textAlign: "center",
  },
  localLink: {
    alignItems: "center",
    paddingVertical: 4,
  },
  localText: {
    color: THEME.textTertiary,
    fontSize: 12,
  },
});
