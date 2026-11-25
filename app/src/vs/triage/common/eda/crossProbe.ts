/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  Cross-probing (ROADMAP P1-4, P1-5; PLAN §4.5): selecting a part or a net in one
 *  view selects it in the others: schematic, board and code.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';

export type ProbeSource = 'schematic' | 'board' | 'code';

export interface IProbe {
	readonly source: ProbeSource;
	/** Reference designators: R1, U2. */
	readonly references: readonly string[];
	/** A net name, when a net (or a pin on it) was picked. */
	readonly net?: string;
}

export const ITriageCrossProbeService = createDecorator<ITriageCrossProbeService>('triageCrossProbeService');

export interface ITriageCrossProbeService {
	readonly _serviceBrand: undefined;
	readonly onDidProbe: Event<IProbe>;
	readonly last: IProbe | undefined;
	probe(probe: IProbe): void;
}

export class TriageCrossProbeService implements ITriageCrossProbeService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidProbe = new Emitter<IProbe>();
	readonly onDidProbe = this._onDidProbe.event;
	private _last: IProbe | undefined;

	get last(): IProbe | undefined {
		return this._last;
	}

	probe(probe: IProbe): void {
		this._last = probe;
		this._onDidProbe.fire(probe);
	}
}
