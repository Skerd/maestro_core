import type {PortalProvider} from "@coreModule/domain/portal/portalProvider.types";

/** What a fixture section needs besides its catalog (D181): an address and a name in every language. */
export function fixtureSectionNames(sitePath = "fixture"): Pick<PortalProvider, "sitePath" | "names"> {
    const name = {title: `Fixture ${sitePath}`, description: `Everything in ${sitePath}.`};
    return {sitePath, names: {"en-US": name, "sq-AL": name, "it-IT": name, "fr-FR": name, "de-CH": name}};
}
