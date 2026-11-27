import type { ConnectionConfig } from "@pi-in-the-sky/client/agent-client";
import {
  type CloudflareDeviceAuth,
  pollCloudflareDeviceToken,
  startCloudflareDeviceAuth,
} from "@pi-in-the-sky/client/cloudflare-device-auth";
import {
  DEPLOY_TO_CLOUDFLARE_URL,
  discoverCloudflareWorker,
  type DiscoveredWorker,
  fetchWorkerStatus,
  provisionWorkerSecrets,
} from "@pi-in-the-sky/client/onboarding";
import { LOCAL_DEV_AUTH_TOKEN } from "@pi-in-the-sky/client/protocol";
import { useEffect, useRef, useState } from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

import { signInWithCloudflareAccess } from "../native";
import { THEME } from "../theme";
import { onboardingStyles } from "./OnboardingView.styles";

type OnboardingStep =
  "connect" | "cf_verify" | "select_account" | "deploy" | "access_login";

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
  const [matchedWorkers, setMatchedWorkers] = useState<
    readonly DiscoveredWorker[]
  >([]);
  const [workerUrl, setWorkerUrl] = useState("");
  const [teamDomain, setTeamDomain] = useState("");
  const [clientId, setClientId] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const flowEpochRef = useRef(0);
  const configuringRef = useRef(false);

  useEffect(() => {
    return () => {
      flowEpochRef.current += 1;
      configuringRef.current = false;
      pollAbortRef.current?.abort();
    };
  }, []);

  const verifyLiveWorker = async (candidateUrl: string, epoch: number) => {
    setStatusMessage("Connecting...");
    const status = await fetchWorkerStatus(candidateUrl);
    if (flowEpochRef.current !== epoch) {
      return;
    }
    switch (status.kind) {
      case "offline":
        setStatusMessage(null);
        setErrorText(status.reason);
        setStep("deploy");
        return;
      case "live_no_oauth":
        setCfAccessToken("");
        setNearAiApiKey("");
        setMatchedWorkers([]);
        setStatusMessage(null);
        onComplete({
          baseUrl: status.baseUrl,
          authToken: LOCAL_DEV_AUTH_TOKEN,
        });
        return;
      case "live_oauth_ready":
        setCfAccessToken("");
        setNearAiApiKey("");
        setMatchedWorkers([]);
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

  const configureWorker = async (
    token: string,
    target: DiscoveredWorker,
    epoch: number,
  ) => {
    if (flowEpochRef.current !== epoch || configuringRef.current) {
      return;
    }
    configuringRef.current = true;
    try {
      setErrorText(null);
      setStatusMessage("Configuring...");
      const provisioned = await provisionWorkerSecrets(
        token,
        target.accountId,
        nearAiApiKey,
      );
      if (flowEpochRef.current !== epoch) {
        return;
      }
      if (!provisioned.ok) {
        setStatusMessage(null);
        setErrorText(provisioned.error);
        setStep("connect");
        return;
      }
      setWorkerUrl(target.baseUrl);
      await verifyLiveWorker(target.baseUrl, epoch);
    } finally {
      configuringRef.current = false;
    }
  };

  const discoverAndConfigure = async (token: string, epoch: number) => {
    if (flowEpochRef.current !== epoch) {
      return;
    }
    setErrorText(null);
    setStatusMessage("Checking Cloudflare...");
    const discovery = await discoverCloudflareWorker(token);
    if (flowEpochRef.current !== epoch) {
      return;
    }
    switch (discovery.kind) {
      case "found": {
        const single = discovery.matches[0];
        if (
          discovery.accountCount === 1 &&
          discovery.matches.length === 1 &&
          single
        ) {
          await configureWorker(token, single, epoch);
          return;
        }
        setMatchedWorkers(discovery.matches);
        setStatusMessage(null);
        setStep("select_account");
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
    flowEpochRef.current += 1;
    const epoch = flowEpochRef.current;
    setErrorText(null);
    setStatusMessage("Starting Cloudflare sign-in...");
    const started = await startCloudflareDeviceAuth();
    if (flowEpochRef.current !== epoch) {
      return;
    }
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
    if (controller.signal.aborted || flowEpochRef.current !== epoch) {
      return;
    }
    if (!polled.ok) {
      setStatusMessage(null);
      setErrorText(polled.error);
      setStep("connect");
      return;
    }
    setCfAccessToken(polled.accessToken);
    await discoverAndConfigure(polled.accessToken, epoch);
  };

  const handleCancelFlow = () => {
    flowEpochRef.current += 1;
    configuringRef.current = false;
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    setDeviceAuth(null);
    setMatchedWorkers([]);
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
          <View style={onboardingStyles.card}>
            <View style={onboardingStyles.field}>
              <Text style={onboardingStyles.label}>NEAR AI Key</Text>
              <TextInput
                style={onboardingStyles.input}
                value={nearAiApiKey}
                onChangeText={setNearAiApiKey}
                secureTextEntry
                placeholder="sk-..."
                placeholderTextColor={THEME.textTertiary}
              />
            </View>
            <Pressable
              style={onboardingStyles.primaryButton}
              onPress={() => {
                void handleSignInWithCloudflare();
              }}
            >
              <Text style={onboardingStyles.primaryButtonText}>
                Sign in with Cloudflare
              </Text>
            </Pressable>
          </View>
        );
      case "cf_verify":
        return (
          <View style={onboardingStyles.card}>
            <Text style={onboardingStyles.cardTitle}>Approve in Browser</Text>
            <Text style={onboardingStyles.cardBody}>
              Confirm this code in Cloudflare to continue.
            </Text>
            {deviceAuth ? (
              <View style={onboardingStyles.codeBox}>
                <Text style={onboardingStyles.codeText}>
                  {deviceAuth.userCode}
                </Text>
              </View>
            ) : null}
            {deviceAuth ? (
              <Pressable
                style={onboardingStyles.secondaryButton}
                onPress={() => {
                  void Linking.openURL(deviceAuth.verificationUriComplete);
                }}
              >
                <Text style={onboardingStyles.secondaryButtonText}>
                  Open Cloudflare
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              style={onboardingStyles.localLink}
              onPress={handleCancelFlow}
            >
              <Text style={onboardingStyles.localText}>Cancel</Text>
            </Pressable>
          </View>
        );
      case "select_account":
        return (
          <View style={onboardingStyles.card}>
            <Text style={onboardingStyles.cardTitle}>Choose Account</Text>
            <Text style={onboardingStyles.cardBody}>
              Confirm which Cloudflare account should receive your NEAR AI key.
            </Text>
            <ScrollView
              style={onboardingStyles.accountList}
              contentContainerStyle={onboardingStyles.accountListContent}
            >
              {matchedWorkers.map((match) => (
                <Pressable
                  key={match.accountId}
                  style={onboardingStyles.accountOption}
                  disabled={statusMessage !== null}
                  onPress={() => {
                    const epoch = flowEpochRef.current;
                    void configureWorker(cfAccessToken, match, epoch);
                  }}
                >
                  <Text style={onboardingStyles.accountName}>
                    {match.accountName}
                  </Text>
                  <Text style={onboardingStyles.accountUrl}>
                    {match.baseUrl}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              style={onboardingStyles.localLink}
              onPress={handleCancelFlow}
            >
              <Text style={onboardingStyles.localText}>Cancel</Text>
            </Pressable>
          </View>
        );
      case "deploy":
        return (
          <View style={onboardingStyles.card}>
            <Text style={onboardingStyles.cardTitle}>Deploy to Cloudflare</Text>
            <Text style={onboardingStyles.cardBody}>
              Finish deploying in your browser, then continue.
            </Text>
            <Pressable
              style={onboardingStyles.primaryButton}
              onPress={() => {
                void handleOpenDeploy();
              }}
            >
              <Text style={onboardingStyles.primaryButtonText}>
                Deploy to Cloudflare
              </Text>
            </Pressable>
            <Pressable
              style={onboardingStyles.secondaryButton}
              onPress={() => {
                flowEpochRef.current += 1;
                const epoch = flowEpochRef.current;
                void discoverAndConfigure(cfAccessToken, epoch);
              }}
            >
              <Text style={onboardingStyles.secondaryButtonText}>Continue</Text>
            </Pressable>
            <Pressable
              style={onboardingStyles.localLink}
              onPress={handleCancelFlow}
            >
              <Text style={onboardingStyles.localText}>Back</Text>
            </Pressable>
          </View>
        );
      case "access_login":
        return (
          <View style={onboardingStyles.card}>
            <Text style={onboardingStyles.cardTitle}>Sign In</Text>
            <Text style={onboardingStyles.cardBody}>{teamDomain}</Text>
            <Pressable
              style={onboardingStyles.primaryButton}
              onPress={() => {
                void handleAccessLogin();
              }}
            >
              <Text style={onboardingStyles.primaryButtonText}>
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
    <View style={onboardingStyles.container}>
      <View style={onboardingStyles.frame}>
        <View style={onboardingStyles.header}>
          <Text style={onboardingStyles.title}>Pi in the Sky</Text>
          <Text style={onboardingStyles.subtitle}>
            Set up your personal assistant
          </Text>
        </View>

        {renderStep(step)}

        {statusMessage ? (
          <Text style={onboardingStyles.status}>{statusMessage}</Text>
        ) : null}
        {errorText ? (
          <Text style={onboardingStyles.error}>{errorText}</Text>
        ) : null}
      </View>
    </View>
  );
}
