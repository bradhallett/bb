import { describe, expect, it } from "vitest";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import {
  validatePluginProviderDeclaration,
  type NormalizedPluginProviderDeclaration,
} from "@get-bb/plugin-sdk/internal/host-policy";
import { buildPluginProviderRegistration } from "./plugin-provider-registration.js";
import { createProviderRegistryService } from "./provider-registry.js";
import { resolveBridgeLaunchForProviderId } from "../system/provider-bridge-launch.js";
import { PluginHostArtifactRegistry } from "../plugins/plugin-host-artifact-registry.js";
import type { ProviderRegistration } from "./provider-registry.js";

function normalizedDeclaration(
  capabilitiesOverride: Partial<PluginProviderDeclaration["capabilities"]> = {},
): NormalizedPluginProviderDeclaration {
  return validatePluginProviderDeclaration({
    id: "my-agent",
    displayName: "My Agent",
    maintenance: { health: false, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["medium"],
      ...capabilitiesOverride,
    },
    composerActions: [],
  });
}

function registrationWith(
  capabilitiesOverride: Partial<PluginProviderDeclaration["capabilities"]>,
): ProviderRegistration {
  const base = buildPluginProviderRegistration({
    available: true,
    pluginId: "plugin-my-agent",
    declaration: normalizedDeclaration(capabilitiesOverride),
    iconHash: null,
    readSettings: () => ({}),
  });
  return {
    ...base,
    pluginId: "plugin-my-agent",
    iconNames: new Set<string>(),
  };
}

function launchDeps(registration: ProviderRegistration) {
  const providerRegistry = createProviderRegistryService();
  providerRegistry.register(registration);
  const pluginHostArtifacts = new PluginHostArtifactRegistry();
  pluginHostArtifacts.set(registration.pluginId, {
    path: "/plugins/plugin-my-agent.tgz",
    byteLength: 1024,
    digest: "a".repeat(64),
    generation: "gen-1",
  });
  return { providerRegistry, pluginHostArtifacts };
}

describe("subagent capability surfacing", () => {
  it("carries the declaration into ProviderInfo capabilities, absent reading false", () => {
    expect(
      registrationWith({ supportsSubagents: true }).info.capabilities
        .supportsSubagents,
    ).toBe(true);
    expect(registrationWith({}).info.capabilities.supportsSubagents).toBe(
      false,
    );
  });

  it("sets supportsSubagents explicitly in the bridge launch construction", () => {
    expect(
      resolveBridgeLaunchForProviderId(
        launchDeps(registrationWith({ supportsSubagents: true })),
        "my-agent",
      )?.capabilities.supportsSubagents,
    ).toBe(true);
    expect(
      resolveBridgeLaunchForProviderId(
        launchDeps(registrationWith({})),
        "my-agent",
      )?.capabilities.supportsSubagents,
    ).toBe(false);
  });
});
