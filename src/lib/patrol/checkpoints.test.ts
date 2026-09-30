import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DAWIE_FARM_CHECKPOINTS, matchCheckpoint } from './checkpoints';

describe('PDF QR Checkpoint Cards Matching', () => {
  it('matches all 6 printed PDF cards accurately', () => {
    // Checkpoint 1: Hoofhek
    const cp1 = matchCheckpoint('PLAAS-CP:CP1', DAWIE_FARM_CHECKPOINTS);
    assert.ok(cp1, 'CP1 should match');
    assert.strictEqual(cp1?.orderIndex, 1);
    assert.ok(cp1?.name.includes('Hoofhek'));

    // Checkpoint 2: Skaapkraal
    const cp2 = matchCheckpoint('PLAAS-CP:CP2', DAWIE_FARM_CHECKPOINTS);
    assert.ok(cp2, 'CP2 should match');
    assert.strictEqual(cp2?.orderIndex, 2);
    assert.ok(cp2?.name.includes('Skaapkraal'));

    // Checkpoint 3: Hoenderhok
    const cp3 = matchCheckpoint('PLAAS-CP:CP3', DAWIE_FARM_CHECKPOINTS);
    assert.ok(cp3, 'CP3 should match');
    assert.strictEqual(cp3?.orderIndex, 3);
    assert.ok(cp3?.name.includes('Hoenderhok'));

    // Checkpoint 4: Stoor en werkswinkel
    const cp4 = matchCheckpoint('PLAAS-CP:CP4', DAWIE_FARM_CHECKPOINTS);
    assert.ok(cp4, 'CP4 should match');
    assert.strictEqual(cp4?.orderIndex, 4);
    assert.ok(cp4?.name.includes('Stoor'));

    // Checkpoint 5: Skadunet-tuin
    const cp5 = matchCheckpoint('PLAAS-CP:CP5', DAWIE_FARM_CHECKPOINTS);
    assert.ok(cp5, 'CP5 should match');
    assert.strictEqual(cp5?.orderIndex, 5);
    assert.ok(cp5?.name.includes('Skadunet'));

    // Checkpoint 6: Grensdraad noord
    const cp6 = matchCheckpoint('PLAAS-CP:CP6', DAWIE_FARM_CHECKPOINTS);
    assert.ok(cp6, 'CP6 should match');
    assert.strictEqual(cp6?.orderIndex, 6);
    assert.ok(cp6?.name.includes('Grensdraad'));
  });

  it('matches cryptographic tokens and NFC tags', () => {
    const cpGate = matchCheckpoint('EE-CP-MAIN-GATE-01', DAWIE_FARM_CHECKPOINTS);
    assert.ok(cpGate);
    assert.strictEqual(cpGate?.orderIndex, 1);

    const cpNfc = matchCheckpoint('04:7A:B2:C2', DAWIE_FARM_CHECKPOINTS);
    assert.ok(cpNfc);
    assert.strictEqual(cpNfc?.orderIndex, 2);

    const cpNfcNormalized = matchCheckpoint('047AB2C3', DAWIE_FARM_CHECKPOINTS);
    assert.ok(cpNfcNormalized);
    assert.strictEqual(cpNfcNormalized?.orderIndex, 3);
  });

  it('rejects completely invalid strings', () => {
    assert.strictEqual(matchCheckpoint('', DAWIE_FARM_CHECKPOINTS), undefined);
    assert.strictEqual(matchCheckpoint('random-unknown-garbage', DAWIE_FARM_CHECKPOINTS), undefined);
  });
});
