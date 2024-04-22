import type { RsbuildPluginAPI } from '@rsbuild/core';
import {
  type SplitChunks,
  createCacheGroups,
  isPlainObject,
} from '@rsbuild/shared';
import type { SplitVueChunkOptions } from '.';

export const applySplitChunksRule = (
  api: RsbuildPluginAPI,
  options: SplitVueChunkOptions = {
    vue: true,
    router: true,
  },
) => {
  api.modifyBundlerChain((chain) => {
    const config = api.getNormalizedConfig();
    if (config.performance.chunkSplit.strategy !== 'split-by-experience') {
      return;
    }

    const currentConfig = chain.optimization.splitChunks.values();
    if (!isPlainObject(currentConfig)) {
      return;
    }

    const extraGroups: Record<string, (string | RegExp)[]> = {};

    if (options.vue) {
      extraGroups.vue = [
        'vue',
        'vue-loader',
        /@vue[\\/](shared|reactivity|runtime-dom|runtime-core)/,
      ];
    }

    if (options.router) {
      extraGroups.router = ['vue-router'];
    }

    if (!Object.keys(extraGroups).length) {
      return;
    }

    chain.optimization.splitChunks({
      ...currentConfig,
      // @ts-expect-error Rspack and Webpack uses different cacheGroups type
      cacheGroups: {
        ...(currentConfig as Exclude<SplitChunks, false>).cacheGroups,
        ...createCacheGroups(extraGroups),
      },
    });
  });
};
