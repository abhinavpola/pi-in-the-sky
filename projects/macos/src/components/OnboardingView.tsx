import type { ConnectionConfig } from "@pi-in-the-sky/client/agent-client";
import {
  type CloudflareAccount,
  pollCloudflareDeviceToken,
  startCloudflareDeviceAuth,
} from "@pi-in-the-sky/client/cloudflare-device-auth";
import { deployCloudflareWorker } from "@pi-in-the-sky/client/cloudflare-worker-api";
import {
  discoverCloudflareWorker,
  type DiscoveredWorker,
  fetchWorkerStatus,
  provisionWorkerSecrets,
} from "@pi-in-the-sky/client/onboarding";
import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, Text, TextInput, View } from "react-native";

import { generateRandomToken, signInWithCloudflareAccess } from "../native";
import { THEME } from "../theme";
import {
  DeployWorkerCard,
  SelectAccountCard,
} from "./OnboardingCloudflareCards";
import { type OnboardingState, OnboardingStepper } from "./OnboardingStepper";
import { onboardingStyles } from "./OnboardingView.styles";

type OnboardingViewProps = {
  readonly onComplete: (config: ConnectionConfig) => void;
};

export function OnboardingView({ onComplete }: OnboardingViewProps) {
  const [state, setState] = useState<OnboardingState>({ kind: "cf_connect" });
  const [nearAiApiKey, setNearAiApiKey] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const flowEpochRef = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    return () => {
      flowEpochRef.current += 1;
      busyRef.current = false;
      pollAbortRef.current?.abort();
    };
  }, []);

  const verifyLiveWorker = async (
    candidateUrl: string,
    epoch: number,
    agentAuthToken: string,
  ) => {
    setStatusMessage("Connecting...");
    const status = await fetchWorkerStatus(candidateUrl);
    if (flowEpochRef.current !== epoch) {
      return;
    }
    switch (status.kind) {
      case "offline":
        setStatusMessage(null);
        setErrorText(status.reason);
        return;
      case "live_no_oauth":
        setNearAiApiKey("");
        setStatusMessage(null);
        onComplete({
          baseUrl: status.baseUrl,
          authToken: agentAuthToken,
        });
        return;
      case "live_oauth_ready":
        setNearAiApiKey("");
        setStatusMessage(null);
        setState({
          kind: "access_login",
          workerUrl: status.baseUrl,
          teamDomain: status.teamDomain,
          clientId: status.clientId,
        });
        return;
      default: {
        status satisfies never;
      }
    }
  };

  const deployToAccount = async (
    token: string,
    account: CloudflareAccount,
    accounts: readonly CloudflareAccount[],
    epoch: number,
  ) => {
    if (flowEpochRef.current !== epoch || busyRef.current) {
      return;
    }
    busyRef.current = true;
    try {
      setErrorText(null);
      setStatusMessage(`Deploying to ${account.name}...`);
      const deployed = await deployCloudflareWorker(
        token,
        account.id,
        account.name,
      );
      if (flowEpochRef.current !== epoch) {
        return;
      }
      if (!deployed.ok) {
        setStatusMessage(null);
        setErrorText(deployed.error);
        setState({ kind: "cf_deploy", cfAccessToken: token, accounts });
        return;
      }
      setStatusMessage(null);
      setState({
        kind: "provider",
        cfAccessToken: token,
        worker: deployed.worker,
        fallbackWorkers: [],
      });
    } finally {
      busyRef.current = false;
    }
  };

  const discoverWorker = async (token: string, epoch: number) => {
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
          setStatusMessage(null);
          setState({
            kind: "provider",
            cfAccessToken: token,
            worker: single,
            fallbackWorkers: [],
          });
          return;
        }
        setStatusMessage(null);
        setState({
          kind: "cf_select_account",
          cfAccessToken: token,
          workers: discovery.matches,
        });
        return;
      }
      case "not_deployed":
        setStatusMessage(null);
        setState({
          kind: "cf_deploy",
          cfAccessToken: token,
          accounts: discovery.deployableAccounts,
        });
        return;
      case "error":
        setStatusMessage(null);
        setErrorText(discovery.message);
        setState({ kind: "cf_connect" });
        return;
      default: {
        discovery satisfies never;
      }
    }
  };

  const handleSignInWithCloudflare = async () => {
    if (statusMessage !== null) {
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
    setStatusMessage("Waiting for approval...");
    setState({ kind: "cf_verify", deviceAuth: started.value });
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
      setState({ kind: "cf_connect" });
      return;
    }
    await discoverWorker(polled.accessToken, epoch);
  };

  const handleConfigureProvider = async (
    cfAccessToken: string,
    worker: DiscoveredWorker,
  ) => {
    if (!nearAiApiKey.trim() || busyRef.current) {
      return;
    }
    const epoch = flowEpochRef.current;
    busyRef.current = true;
    try {
      setErrorText(null);
      setStatusMessage("Configuring...");
      const tokenRes = await generateRandomToken(32);
      if (flowEpochRef.current !== epoch) {
        return;
      }
      if (!tokenRes.ok) {
        setStatusMessage(null);
        setErrorText(tokenRes.error);
        return;
      }
      const provisioned = await provisionWorkerSecrets(
        cfAccessToken,
        worker.accountId,
        nearAiApiKey,
        tokenRes.value,
      );
      if (flowEpochRef.current !== epoch) {
        return;
      }
      if (!provisioned.ok) {
        setStatusMessage(null);
        setErrorText(provisioned.error);
        return;
      }
      setNearAiApiKey("");
      await verifyLiveWorker(worker.baseUrl, epoch, tokenRes.value);
    } finally {
      busyRef.current = false;
    }
  };

  const handleCancelFlow = () => {
    flowEpochRef.current += 1;
    busyRef.current = false;
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    setNearAiApiKey("");
    setStatusMessage(null);
    setErrorText(null);
    setState({ kind: "cf_connect" });
  };

  const handleAccessLogin = async (
    workerUrl: string,
    teamDomain: string,
    clientId: string,
  ) => {
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

  const renderState = (current: OnboardingState) => {
    switch (current.kind) {
      case "cf_connect":
        return (
          <View style={onboardingStyles.card}>
            <Text style={onboardingStyles.cardTitle}>Cloudflare</Text>
            <Text style={onboardingStyles.cardBody}>
              Sign in to connect or deploy your personal Worker.
            </Text>
            <Pressable
              style={onboardingStyles.primaryButton}
              disabled={statusMessage !== null}
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
            <View style={onboardingStyles.codeBox}>
              <Text style={onboardingStyles.codeText}>
                {current.deviceAuth.userCode}
              </Text>
            </View>
            <Pressable
              style={onboardingStyles.secondaryButton}
              onPress={() => {
                void Linking.openURL(
                  current.deviceAuth.verificationUriComplete,
                );
              }}
            >
              <Text style={onboardingStyles.secondaryButtonText}>
                Open Cloudflare
              </Text>
            </Pressable>
            <Pressable
              style={onboardingStyles.localLink}
              onPress={handleCancelFlow}
            >
              <Text style={onboardingStyles.localText}>Cancel</Text>
            </Pressable>
          </View>
        );
      case "cf_select_account":
        return (
          <SelectAccountCard
            workers={current.workers}
            onSelect={(match) => {
              setErrorText(null);
              setState({
                kind: "provider",
                cfAccessToken: current.cfAccessToken,
                worker: match,
                fallbackWorkers: current.workers,
              });
            }}
            onCancel={handleCancelFlow}
          />
        );
      case "cf_deploy":
        return (
          <DeployWorkerCard
            accounts={current.accounts}
            disabled={statusMessage !== null}
            onDeploy={(account) => {
              const epoch = flowEpochRef.current;
              void deployToAccount(
                current.cfAccessToken,
                account,
                current.accounts,
                epoch,
              );
            }}
            onBack={handleCancelFlow}
          />
        );
      case "provider":
        return (
          <View style={onboardingStyles.card}>
            <Text style={onboardingStyles.cardTitle}>Inference Provider</Text>
            <Text style={onboardingStyles.cardBody}>
              Add your NEAR AI key for {current.worker.accountName}.
            </Text>
            <View style={onboardingStyles.field}>
              <Text style={onboardingStyles.label}>NEAR AI Key</Text>
              <TextInput
                style={onboardingStyles.input}
                value={nearAiApiKey}
                onChangeText={setNearAiApiKey}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                returnKeyType="done"
                submitBehavior="blurAndSubmit"
                onSubmitEditing={() => {
                  void handleConfigureProvider(
                    current.cfAccessToken,
                    current.worker,
                  );
                }}
                placeholder="sk-..."
                placeholderTextColor={THEME.textSecondary}
              />
            </View>
            {nearAiApiKey.trim().length > 0 ? (
              <Pressable
                style={onboardingStyles.primaryButton}
                disabled={statusMessage !== null}
                onPress={() => {
                  void handleConfigureProvider(
                    current.cfAccessToken,
                    current.worker,
                  );
                }}
              >
                <Text style={onboardingStyles.primaryButtonText}>Continue</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={onboardingStyles.localLink}
              disabled={statusMessage !== null}
              onPress={() => {
                setErrorText(null);
                if (current.fallbackWorkers.length > 0) {
                  setState({
                    kind: "cf_select_account",
                    cfAccessToken: current.cfAccessToken,
                    workers: current.fallbackWorkers,
                  });
                  return;
                }
                handleCancelFlow();
              }}
            >
              <Text style={onboardingStyles.localText}>Back</Text>
            </Pressable>
          </View>
        );
      case "access_login":
        return (
          <View style={onboardingStyles.card}>
            <Text style={onboardingStyles.cardTitle}>Sign In</Text>
            <Text style={onboardingStyles.cardBody}>{current.teamDomain}</Text>
            <Pressable
              style={onboardingStyles.primaryButton}
              onPress={() => {
                void handleAccessLogin(
                  current.workerUrl,
                  current.teamDomain,
                  current.clientId,
                );
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

        <OnboardingStepper step={state.kind} />

        {renderState(state)}

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
