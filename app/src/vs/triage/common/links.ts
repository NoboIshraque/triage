/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  .triage/links.json, the cross-domain link graph (PLAN §4.4; v0 in ROADMAP P1-5,
 *  format 1 in P3): the schematic's components with their values and pins, and its
 *  nets with the firmware constant each one has. The window writes it from KiCad's
 *  engine whenever the schematic changes; the simulation and the triage CLI read
 *  it, so they run without KiCad. No VS Code imports: the EDA engine test checks
 *  the committed example against the engine with this same code.
 *--------------------------------------------------------------------------------------------*/

export const LINKS_FORMAT = 1;

/** A component as the EDA engine's netlist reports it. */
export interface ILinksInputComponent {
	readonly reference: string;
	readonly libId: string;
	readonly value: string;
	readonly footprint: string;
	readonly pins: readonly { readonly number: string; readonly name: string; readonly net: string }[];
}

/** A net's firmware side, from the pin map. */
export interface ILinksFirmware {
	readonly constant: string;
	readonly pin: string;
	readonly number: number;
}

export interface ILinks {
	readonly format: number;
	readonly generator: string;
	readonly schematic: string;
	readonly board: { readonly profile: string; readonly symbol: string };
	readonly components: readonly {
		readonly reference: string;
		readonly symbol: string;
		readonly value: string;
		readonly footprint: string;
		readonly pins: readonly { readonly number: string; readonly name: string; readonly net: string }[];
	}[];
	readonly nets: readonly { readonly name: string; readonly pins: readonly string[]; readonly firmware?: ILinksFirmware }[];
}

/** Sorts R2 before R10. */
function natural(a: string, b: string): number {
	return a.localeCompare(b, 'en', { numeric: true });
}

/** KiCad gives every unconnected pin a net of its own ("unconnected-(A1-NC-Pad1)"). */
function connected(net: string): string {
	return net.startsWith('unconnected-') ? '' : net;
}

/** The link graph of a schematic's netlist; power symbols (#FLG, #PWR) are left out. */
export function buildLinks(
	schematic: string,
	board: { profile: string; symbol: string },
	components: readonly ILinksInputComponent[],
	firmware: (net: string) => ILinksFirmware | undefined,
): ILinks {
	const parts = components
		.filter(c => !c.reference.startsWith('#'))
		.map(c => ({
			reference: c.reference,
			symbol: c.libId,
			value: c.value,
			footprint: c.footprint,
			pins: [...c.pins]
				.map(p => ({ number: p.number, name: p.name, net: connected(p.net) }))
				.sort((a, b) => natural(a.number, b.number)),
		}))
		.sort((a, b) => natural(a.reference, b.reference));
	const nets = new Map<string, string[]>();
	for (const part of parts) {
		for (const pin of part.pins) {
			if (pin.net) {
				nets.set(pin.net, [...(nets.get(pin.net) ?? []), `${part.reference}.${pin.number}`]);
			}
		}
	}
	return {
		format: LINKS_FORMAT,
		generator: 'Triage (ROADMAP P1-5, P3)',
		schematic,
		board,
		components: parts,
		nets: [...nets].sort(([a], [b]) => a.localeCompare(b)).map(([name, pins]) => {
			const fw = firmware(name);
			return fw ? { name, pins, firmware: fw } : { name, pins };
		}),
	};
}

/** links.json's text. */
export function linksText(links: ILinks): string {
	return `${JSON.stringify(links, null, '\t')}\n`;
}
