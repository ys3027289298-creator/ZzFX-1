// record_demo.js - screen recording of the ZzFX MIDI export feature
// serves the repo's own index.html and drives it in a headless browser,
// each segment introduced by a title card; video lands in output/
// usage: node output/record_demo.js   (run from the repo root)

const {chromium} = require('playwright');
const {createServer} = require('http');
const {readFileSync, mkdirSync} = require('fs');
const {extname, join} = require('path');

const ROOT = __dirname + '/..';
const MIME = {'.html':'text/html', '.js':'text/javascript', '.png':'image/png', '.json':'application/json'};

(async () =>
{
    const server = createServer((req, res) =>
    {
        const path = join(ROOT, req.url == '/' ? 'index.html' : req.url.split('?')[0]);
        try
        {
            const body = readFileSync(path);
            res.writeHead(200, {'content-type': MIME[extname(path)] || 'application/octet-stream'});
            res.end(body);
        }
        catch { res.writeHead(404); res.end(); }
    });
    await new Promise(r => server.listen(8931, r));

    mkdirSync(ROOT + '/output/video', {recursive: true});
    const browser = await chromium.launch();
    const context = await browser.newContext(
    {
        viewport: {width: 1280, height: 800},
        recordVideo: {dir: ROOT + '/output/video', size: {width: 1280, height: 800}},
    });
    const page = await context.newPage();

    // title card overlay helpers
    const title = (text, sub='') => page.evaluate(([text, sub]) =>
    {
        let el = document.getElementById('__titlecard');
        if (!el)
        {
            el = document.createElement('div');
            el.id = '__titlecard';
            el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.88);' +
                'color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
                'font:bold 40px sans-serif;text-align:center;gap:16px';
            document.body.appendChild(el);
        }
        el.style.display = 'flex';
        el.innerHTML = `<div>${text}</div><div style="font:20px monospace;color:#8f8">${sub}</div>`;
    }, [text, sub]);
    const untitle = () => page.evaluate(() =>
        document.getElementById('__titlecard').style.display = 'none');
    const beat = ms => page.waitForTimeout(ms);

    await page.goto('http://localhost:8931/');
    await page.waitForSelector('#UI:not([style*="none"])');

    // segment 1 - the feature entry point
    await title('ZzFX MIDI Export', 'segment 1/4 - the sound designer, now with Save Midi');
    await beat(2500);
    await untitle();
    await page.hover('text=Save Midi');
    await beat(1200);

    // segment 2 - mapping preview and diagnostics
    await title('Parameter Mapping & Diagnostics', 'segment 2/4 - unmappable parameters are reported, not dropped');
    await beat(2500);
    await untitle();
    await page.click('text=Save Midi');
    await beat(2500);

    // segment 3 - timeline and pitch are user settable
    await title('Timeline & Pitch Controls', 'segment 3/4 - set tempo (BPM) and pitch offset (semitones)');
    await beat(2500);
    await untitle();
    await page.fill('#input_midiBpm', '90');
    await page.dispatchEvent('#input_midiBpm', 'input');
    await beat(1200);
    await page.fill('#input_midiPitch', '-12');
    await page.dispatchEvent('#input_midiPitch', 'input');
    await beat(1800);

    // segment 4 - export a real .mid download
    await title('Export Standard MIDI File', 'segment 4/4 - SMF type 0, opens in any DAW');
    await beat(2500);
    await untitle();
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.click('#dialog_midi .btn-primary'),
    ]);
    await download.saveAs(ROOT + '/output/demo_export.mid');
    await beat(1500);

    await context.close();
    await browser.close();
    server.close();
    console.log('recorded to output/video/, download saved to output/demo_export.mid');
})();
