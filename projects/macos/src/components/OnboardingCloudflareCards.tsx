import type { CloudflareAccount } from "@pi-in-the-sky/client/cloudflare-device-auth";
import type { DiscoveredWorker } from "@pi-in-the-sky/client/onboarding";
import { Pressable, ScrollView, Text, View } from "react-native";

import { onboardingStyles } from "./OnboardingView.styles";

type SelectAccountCardProps = {
  readonly workers: readonly DiscoveredWorker[];
  readonly onSelect: (worker: DiscoveredWorker) => void;
  readonly onCancel: () => void;
};

export function SelectAccountCard({
  workers,
  onSelect,
  onCancel,
}: SelectAccountCardProps) {
  return (
    <View style={onboardingStyles.card}>
      <Text style={onboardingStyles.cardTitle}>Choose Account</Text>
      <Text style={onboardingStyles.cardBody}>
        Select which Cloudflare account to use.
      </Text>
      <ScrollView
        style={onboardingStyles.accountList}
        contentContainerStyle={onboardingStyles.accountListContent}
      >
        {workers.map((match) => (
          <Pressable
            key={match.accountId}
            style={onboardingStyles.accountOption}
            onPress={() => onSelect(match)}
          >
            <Text style={onboardingStyles.accountName}>
              {match.accountName}
            </Text>
            <Text style={onboardingStyles.accountUrl}>{match.baseUrl}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <Pressable style={onboardingStyles.localLink} onPress={onCancel}>
        <Text style={onboardingStyles.localText}>Cancel</Text>
      </Pressable>
    </View>
  );
}

type DeployWorkerCardProps = {
  readonly accounts: readonly CloudflareAccount[];
  readonly disabled: boolean;
  readonly onDeploy: (account: CloudflareAccount) => void;
  readonly onBack: () => void;
};

export function DeployWorkerCard({
  accounts,
  disabled,
  onDeploy,
  onBack,
}: DeployWorkerCardProps) {
  const singleAccount = accounts.length === 1 ? accounts[0] : null;
  return (
    <View style={onboardingStyles.card}>
      <Text style={onboardingStyles.cardTitle}>Deploy to Cloudflare</Text>
      <Text style={onboardingStyles.cardBody}>
        {singleAccount
          ? `Deploy your personal Worker to ${singleAccount.name}.`
          : "Choose which Cloudflare account should host your Worker."}
      </Text>
      {singleAccount ? (
        <Pressable
          style={onboardingStyles.primaryButton}
          disabled={disabled}
          onPress={() => onDeploy(singleAccount)}
        >
          <Text style={onboardingStyles.primaryButtonText}>
            Deploy to Cloudflare
          </Text>
        </Pressable>
      ) : (
        <ScrollView
          style={onboardingStyles.accountList}
          contentContainerStyle={onboardingStyles.accountListContent}
        >
          {accounts.map((account) => (
            <Pressable
              key={account.id}
              style={onboardingStyles.accountOption}
              disabled={disabled}
              onPress={() => onDeploy(account)}
            >
              <Text style={onboardingStyles.accountName}>{account.name}</Text>
              <Text style={onboardingStyles.accountUrl}>{account.id}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <Pressable style={onboardingStyles.localLink} onPress={onBack}>
        <Text style={onboardingStyles.localText}>Back</Text>
      </Pressable>
    </View>
  );
}
