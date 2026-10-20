import { matchesTrust } from '../npm-trust-match';

const target = { repo: 'bugsee/bugsee-react-native', file: 'release.yml', environment: 'npm-publish' };
const ours = { repository: target.repo, file: target.file, environment: target.environment };

describe('matchesTrust', () => {
  it('accepts an entry naming our repo, workflow and environment with publish permission', () => {
    expect(matchesTrust(JSON.stringify([{ ...ours, allowPublish: true }]), target)).toBe(true);
    expect(matchesTrust(JSON.stringify({ trust: [{ ...ours, permissions: ['publish'] }] }), target)).toBe(true);
  });

  it('rejects another repository, even with our workflow and environment', () => {
    const other = { ...ours, repository: 'bugsee/bugsee-react-native-fork', allowPublish: true };
    expect(matchesTrust(JSON.stringify([other]), target)).toBe(false);
  });

  it('rejects a different environment that merely contains ours', () => {
    const other = { ...ours, environment: 'npm-publish-staging', allowPublish: true };
    expect(matchesTrust(JSON.stringify([other]), target)).toBe(false);
  });

  it('rejects an entry that only allows staged publish', () => {
    expect(matchesTrust(JSON.stringify([{ ...ours, allowStagePublish: true }]), target)).toBe(false);
    expect(matchesTrust(JSON.stringify([{ ...ours, permissions: ['stage-publish'] }]), target)).toBe(false);
  });

  it('does not combine values from two different entries', () => {
    const entries = [
      { repository: target.repo, file: 'other.yml', environment: target.environment, allowPublish: true },
      { repository: 'someone/else', file: target.file, environment: target.environment, allowPublish: true },
    ];
    expect(matchesTrust(JSON.stringify(entries), target)).toBe(false);
  });

  it('fails closed on output that is not JSON or is empty', () => {
    expect(matchesTrust('npm error EOTP', target)).toBe(false);
    expect(matchesTrust('[]', target)).toBe(false);
    expect(matchesTrust('', target)).toBe(false);
  });
});
