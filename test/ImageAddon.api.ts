/**
 * Copyright (c) 2020 Joerg Breitbart.
 * @license MIT
 */

import { assert } from 'chai';
import { openTerminal, launchBrowser } from '../../../out-test/api/TestUtils';
import { Browser, Page } from 'playwright';
import { IImageAddonOptions } from '../src/Types';
import { FINALIZER, introducer, sixelEncode } from 'sixel';
import { readFileSync } from 'fs';
import PNG from 'png-ts';

const APP = 'http://127.0.0.1:3001/test';

let browser: Browser;
let page: Page;
const width = 800;
const height = 600;

// eslint-disable-next-line
declare const ImageAddon: {
  new(workerPath: string, options?: Partial<IImageAddonOptions>): any;
};

interface ITestData {
  width: number;
  height: number;
  bytes: Uint8Array;
  palette: number[];
  sixel: string;
}

interface IDimensions {
  cellWidth: number;
  cellHeight: number;
  width: number;
  height: number;
}

const IMAGE_WORKER_PATH = '/workers/xterm-addon-image-worker.js';

// image: 640 x 80, 512 color
const TESTDATA: ITestData = (() => {
  const pngImage = PNG.load(readFileSync('./addons/xterm-addon-image/fixture/palette.png'));
  const data8 = pngImage.decode();
  const data32 = new Uint32Array(data8.buffer);
  const palette = new Set<number>();
  for (let i = 0; i < data32.length; ++i) palette.add(data32[i]);
  const sixel = sixelEncode(data8, pngImage.width, pngImage.height, [...palette]);
  return {
    width: pngImage.width,
    height: pngImage.height,
    bytes: data8,
    palette: [...palette],
    sixel
  };
})();
const SIXEL_SEQ_0 = introducer(0) + TESTDATA.sixel + FINALIZER;
// const SIXEL_SEQ_1 = introducer(1) + TESTDATA.sixel + FINALIZER;
// const SIXEL_SEQ_2 = introducer(2) + TESTDATA.sixel + FINALIZER;


describe.only('ImageAddon', () => {
  before(async () => {
    browser = await launchBrowser();
    page = await (await browser.newContext()).newPage();
    await page.setViewportSize({ width, height });
  });

  after(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    await page.goto(APP);
    await openTerminal(page);
    await page.evaluate(opts => {
      (window as any).imageAddon = new ImageAddon(opts.workerPath, opts.opts);
      (window as any).term.loadAddon((window as any).imageAddon);
    }, { workerPath: IMAGE_WORKER_PATH, opts: { sixelPaletteLimit: 512 } });
  });

  it('test for private accessors', async () => {
    // terminal privates
    const accessors = [
      '_core',
      '_core._dirtyRowService',
      '_core._renderService',
      '_core._inputHandler',
      '_core._inputHandler._parser',
      '_core._inputHandler._curAttrData',
      '_core._colorManager',
      '_core._coreBrowserService'
    ];
    for (const prop of accessors) {
      assert.equal(
        await page.evaluate('(() => { const v = window.term.' + prop + '; return v !== undefined && v !== null; })()'),
        true, `problem at ${prop}`
      );
    }
    // bufferline privates
    assert.equal(await page.evaluate('window.term._core.buffer.lines.get(0)._data instanceof Uint32Array'), true);
    assert.equal(await page.evaluate('window.term._core.buffer.lines.get(0)._extendedAttrs instanceof Object'), true);
    // inputhandler privates
    assert.equal(await page.evaluate('window.term._core._inputHandler._curAttrData.constructor.name'), 'AttributeData');
    assert.equal(await page.evaluate('window.term._core._inputHandler._parser.constructor.name'), 'EscapeSequenceParser');
  });

  describe('ctor options', () => {
    it('empty settings should load defaults', async () => {
      const DEFAULT_OPTIONS: IImageAddonOptions = {
        enableSizeReports: true,
        pixelLimit: 16777216,
        sixelSupport: true,
        sixelScrolling: true,
        sixelPaletteLimit: 512,  // set to 512 to get example image working
        sixelSizeLimit: 25000000,
        storageLimit: 128,
        showPlaceholder: true
      };
      assert.deepEqual(await page.evaluate(`window.imageAddon._opts`), DEFAULT_OPTIONS);
    });
    it('custom settings should overload defaults', async () => {
      const customSettings: IImageAddonOptions = {
        enableSizeReports: false,
        pixelLimit: 5,
        sixelSupport: false,
        sixelScrolling: false,
        sixelPaletteLimit: 1024,
        sixelSizeLimit: 1000,
        storageLimit: 10,
        showPlaceholder: false
      };
      await page.evaluate(opts => {
        (window as any).imageAddonCustom = new ImageAddon(opts.workerPath, opts.opts);
        (window as any).term.loadAddon((window as any).imageAddonCustom);
      }, { workerPath: IMAGE_WORKER_PATH, opts: customSettings });
      assert.deepEqual(await page.evaluate(`window.imageAddonCustom._opts`), customSettings);
    });
  });

  describe('scrolling & cursor modes', () => {
    it('testdata default (scrolling with VT240 cursor pos)', async () => {
      const dim = await getDimensions();
      await writeToTerminal(SIXEL_SEQ_0);
      assert.deepEqual(await getCursor(), [0, Math.floor(TESTDATA.height/dim.cellHeight)]);
      // moved to right by 10 cells
      await writeToTerminal('#'.repeat(10) + SIXEL_SEQ_0);
      assert.deepEqual(await getCursor(), [10, Math.floor(TESTDATA.height/dim.cellHeight) * 2]);
    });
    it('write testdata noScrolling', async () => {
      await writeToTerminal('\x1b[?80h' + SIXEL_SEQ_0);
      assert.deepEqual(await getCursor(), [0, 0]);
      // second draw does not change anything
      await writeToTerminal(SIXEL_SEQ_0);
      assert.deepEqual(await getCursor(), [0, 0]);
    });
    it('testdata cursor always at VT240 pos', async () => {
      const dim = await getDimensions();
      // offset 0
      await writeToTerminal(SIXEL_SEQ_0);
      assert.deepEqual(await getCursor(), [0, Math.floor(TESTDATA.height/dim.cellHeight)]);
      // moved to right by 10 cells
      await writeToTerminal('#'.repeat(10) + SIXEL_SEQ_0);
      assert.deepEqual(await getCursor(), [10, Math.floor(TESTDATA.height/dim.cellHeight) * 2]);
      // moved by 30 cells (+10 prev)
      await writeToTerminal('#'.repeat(30) + SIXEL_SEQ_0);
      assert.deepEqual(await getCursor(), [10 + 30, Math.floor(TESTDATA.height/dim.cellHeight) * 3]);
    });
  });

  describe('image lifecycle & eviction', () => {
    it('delete image once scrolled off', async () => {
      await writeToTerminal(SIXEL_SEQ_0);
      assert.equal(await getImageStorageLength(), 1);
      // scroll to scrollback + rows - 1
      await page.evaluate(
        scrollback => new Promise(res => (window as any).term.write('\n'.repeat(scrollback), res)),
        (await getScrollbackPlusRows() - 1)
      );
      assert.equal(await getImageStorageLength(), 1);
      // scroll one further should delete the image
      await page.evaluate(() => new Promise(res => (window as any).term.write('\n', res)));
      assert.equal(await getImageStorageLength(), 0);
    });
    it('get storageUsage', async () => {
      assert.equal(await page.evaluate('imageAddon.storageUsage'), 0);
      await writeToTerminal(SIXEL_SEQ_0);
      assert.closeTo(await page.evaluate('imageAddon.storageUsage'), 640 * 80 * 4 / 1000000, 0.05);
    });
    it('get/set storageLimit', async () => {
      assert.equal(await page.evaluate('imageAddon.storageLimit'), 128);
      assert.equal(await page.evaluate('imageAddon.storageLimit = 1'), 1);
      assert.equal(await page.evaluate('imageAddon.storageLimit'), 1);
    });
    it('remove images by storage limit pressure', async () => {
      assert.equal(await page.evaluate('imageAddon.storageLimit = 1'), 1);
      // never go beyond storage limit
      await writeToTerminal(SIXEL_SEQ_0);
      await writeToTerminal(SIXEL_SEQ_0);
      await writeToTerminal(SIXEL_SEQ_0);
      await writeToTerminal(SIXEL_SEQ_0);
      const usage = await page.evaluate('imageAddon.storageUsage');
      await writeToTerminal(SIXEL_SEQ_0);
      await writeToTerminal(SIXEL_SEQ_0);
      await writeToTerminal(SIXEL_SEQ_0);
      await writeToTerminal(SIXEL_SEQ_0);
      assert.equal(await page.evaluate('imageAddon.storageUsage'), usage);
      assert.equal(usage as number < 1, true);
    });
    it('set storageLimit removes images synchronously', async () => {
      await writeToTerminal(SIXEL_SEQ_0 + SIXEL_SEQ_0 + SIXEL_SEQ_0 + SIXEL_SEQ_0 + SIXEL_SEQ_0 + SIXEL_SEQ_0);
      const usage: number = await page.evaluate('imageAddon.storageUsage');
      const newUsage: number = await page.evaluate('imageAddon.storageLimit = 1; imageAddon.storageUsage');
      assert.equal(newUsage < usage, true);
      assert.equal(newUsage < 1, true);
    });
    it('clear alternate images on buffer change', async () => {
      assert.equal(await page.evaluate('imageAddon.storageUsage'), 0);
      await writeToTerminal('\x1b[?1049h' + SIXEL_SEQ_0);
      assert.closeTo(await page.evaluate('imageAddon.storageUsage'), 640 * 80 * 4 / 1000000, 0.05);
      await writeToTerminal('\x1b[?1049l');
      assert.equal(await page.evaluate('imageAddon.storageUsage'), 0);
    });
    it('evict tiles by in-place overwrites (only full overwrite tested)', async () => {
      await writeToTerminal('\x1b[H' + SIXEL_SEQ_0 + '\x1b[100;100H');
      const usage = await page.evaluate('imageAddon.storageUsage');
      await writeToTerminal('\x1b[H' + SIXEL_SEQ_0 + '\x1b[100;100H');
      await writeToTerminal('\x1b[H' + SIXEL_SEQ_0 + '\x1b[100;100H');
      await writeToTerminal('\x1b[H' + SIXEL_SEQ_0 + '\x1b[100;100H');
      assert.equal(await page.evaluate('imageAddon.storageUsage'), usage);
    });
    it('manual eviction on alternate buffer must not miss images', async () => {
      await writeToTerminal('\x1b[?1049h');
      await writeToTerminal(SIXEL_SEQ_0 + SIXEL_SEQ_0 + SIXEL_SEQ_0 + SIXEL_SEQ_0 + SIXEL_SEQ_0 + SIXEL_SEQ_0);
      const usage: number = await page.evaluate('imageAddon.storageUsage');
      await writeToTerminal(SIXEL_SEQ_0 + SIXEL_SEQ_0 + SIXEL_SEQ_0 + SIXEL_SEQ_0 + SIXEL_SEQ_0 + SIXEL_SEQ_0);
      await writeToTerminal(SIXEL_SEQ_0 + SIXEL_SEQ_0 + SIXEL_SEQ_0 + SIXEL_SEQ_0 + SIXEL_SEQ_0 + SIXEL_SEQ_0);
      const newUsage: number = await page.evaluate('imageAddon.storageUsage');
      assert.equal(newUsage, usage);
    });
  });

  describe('worker integration & manager', () => {
    async function execOnManager(prop?: string): Promise<any> {
      if (prop) {
        return page.evaluate('window.imageAddon._workerManager.' + prop);
      }
      return page.evaluate('window.imageAddon._workerManager');
    }
    it('gets URL from addon settings', async () => {
      // hard coded default
      assert.equal(await execOnManager('url'), '/workers/xterm-addon-image-worker.js');
      // custom
      await page.evaluate(opts => {
        (window as any).imageAddonCustom = new ImageAddon('xyz.js', opts);
        (window as any).term.loadAddon((window as any).imageAddonCustom);
      }, {});
      assert.equal(await page.evaluate(`window.imageAddonCustom._workerManager.url`), 'xyz.js');
    });
    it('timed chunk pooling', async () =>{
      // image fits into one chunk
      await writeToTerminal(SIXEL_SEQ_0);
      assert.equal(await execOnManager('_memPool.length'), 1);
      assert.notEqual(await execOnManager('_poolCheckerInterval'), undefined);
      const lastActive = await execOnManager('_lastActive');
      assert.notEqual(lastActive, 0);
    });
    it.skip('max chunks with cleanup after 20s', async function (): Promise<void> {
      // Note: by default this test is skipped as it takes really long
      this.timeout(30000);
      // more than max chunks created (exceeding pooling)
      const count = 100; // MAX_CHUNKS is 50
      const chunkLength = Math.ceil(SIXEL_SEQ_0.length/count);
      for (let i = 0; i < count; ++i) {
        const offset = i * chunkLength;
        page.evaluate(data => (window as any).term.write(data), SIXEL_SEQ_0.slice(offset, offset + chunkLength));
      }
      await writeToTerminal(''); // wait until all got consumed
      assert.equal(await execOnManager('_memPool.length'), 50);
      assert.notEqual(await execOnManager('_poolCheckerInterval'), undefined);
      const lastActive = await execOnManager('_lastActive');
      assert.notEqual(lastActive, 0);
      // should drop back to 0 after 20000
      await new Promise<void>(res => setTimeout(async () => {
        assert.equal(await execOnManager('_memPool.length'), 0);
        assert.equal(await execOnManager('_poolCheckerInterval'), undefined);
        res();
      }, 20000));
    });
    it('dispose should stop everything', async () => {
      await writeToTerminal(SIXEL_SEQ_0);
      const mustResolveWithDispose = execOnManager('sixelEnd(true)').then(() => 'yeah');
      await execOnManager('dispose()');
      // worker gone
      assert.equal(await execOnManager('_worker'), undefined);
      // pending resolver cleared
      assert.equal(await mustResolveWithDispose, 'yeah');
      assert.equal(await execOnManager('_sixelResolver'), undefined);
      // pool and checker cleared
      assert.equal(await execOnManager('_memPool.length'), 0);
      assert.equal(await execOnManager('_poolCheckerInterval'), undefined);
    });
    describe('handle worker loading error gracefully', () => {
      beforeEach(async () => {
        await page.evaluate(opts => {
          (window as any).imageAddonCustom = new ImageAddon('xyz.js', opts);
          (window as any).term.loadAddon((window as any).imageAddonCustom);
        }, {});
      });
      it('failed is set upon first worker access', async () => {
        assert.equal(await page.evaluate(`window.imageAddonCustom._workerManager.failed`), false);
        // We have to test it here with .endSixel as it is the only promised method
        // we have implemented. This is needed to wait here for the full request-response
        // cycling of the initial ACK message after the lazy worker loading.
        assert.equal(await page.evaluate(`window.imageAddonCustom._workerManager.sixelEnd(true)`), null);
        // Alternatively we could have waited for some time after the first `worker` access.
        // await page.evaluate(`window.imageAddonCustom._workerManager.worker`);
        // await new Promise(res => setTimeout(res, 50));
        assert.equal(await page.evaluate(`window.imageAddonCustom._workerManager.failed`), true);
        // Note: For the sixel handler this means that early `sixelInit` and `sixelPut` API calls
        // are still not a NOOP, as the worker instance in the manager still looks healthy.
        // This is not really a problem, as those calls are only sending and not waiting for response.
        // A minor optimization in the handler tests for the failed state on every action to spot it as
        // early as possible.
      });
      it('sequence turns into NOOP, handler does not block forever', async () => {
        // dispose normal image addon
        await page.evaluate(`window.imageAddon.dispose()`);
        // proper SIXEL sequence
        await writeToTerminal('#' + SIXEL_SEQ_0 + '#');
        assert.deepEqual(await getCursor(), [2, 0]);
        // sequence with color definition but missing SIXEL bytes (0 pixel image)
        await writeToTerminal('#' + '\x1bPq#14;2;0;100;100\x1b\\' + '#');
        assert.deepEqual(await getCursor(), [4, 0]);
        // shortest possible sequence (no data bytes at all)
        await writeToTerminal('#' + '\x1bPq\x1b\\' + '#');
        assert.deepEqual(await getCursor(), [6, 0]);
      });
    });
  });

});

/**
 * terminal access helpers.
 */
async function getDimensions(): Promise<IDimensions> {
  const dimensions: any = await page.evaluate(`term._core._renderService.dimensions`);
  return {
    cellWidth: Math.round(dimensions.actualCellWidth),
    cellHeight: Math.round(dimensions.actualCellHeight),
    width: Math.round(dimensions.canvasWidth),
    height: Math.round(dimensions.canvasHeight)
  };
}

async function getCursor(): Promise<[number, number]> {
  return page.evaluate('[window.term.buffer.active.cursorX, window.term.buffer.active.cursorY]');
}

async function getImageStorageLength(): Promise<number> {
  return page.evaluate('window.imageAddon._storage._images.size');
}

async function getScrollbackPlusRows(): Promise<number> {
  return page.evaluate('window.term.options.scrollback + window.term.rows');
}

async function writeToTerminal(d: string): Promise<any> {
  return page.evaluate(data => new Promise(res => (window as any).term.write(data, res)), d);
}
