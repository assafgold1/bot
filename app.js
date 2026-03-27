const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Events,
    MessageFlags,
    SlashCommandBuilder,
    PermissionFlagsBits,
    REST,
    Routes,
    ActivityType,
    PresenceUpdateStatus
} = require('discord.js');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const axios = require('axios');
const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');
const Database = require('better-sqlite3');
const TOKEN = 'MTE2MDI4OTQ3NjE5MTQ1MzI5Ng.GrEWIq.oJv9b5KHF6vzD2OjDGJLhZEhpTA0nu_G3B7O2s';
const CLIENT_ID = '1160289476191453296';
const OWNER_ID = '411593190865633282';
const POLYGONS_FILE = 'cities_polygons.json';
const ALERT_API = "https://www.oref.org.il/WarningMessages/alert/alerts.json";

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ]
});

let polygonsData = {};
if (fs.existsSync(POLYGONS_FILE)) {
    polygonsData = JSON.parse(fs.readFileSync(POLYGONS_FILE, 'utf8'));
} else {
    console.error("❌ קובץ cities_polygons.json חסר!");
    process.exit(1);
}

const db = new Database('bot_data.db');
db.prepare('CREATE TABLE IF NOT EXISTS settings (guildId TEXT PRIMARY KEY, channelId TEXT, roleId TEXT)').run();
db.prepare('CREATE TABLE IF NOT EXISTS tiles (url TEXT PRIMARY KEY, data BLOB)').run();
db.prepare('CREATE TABLE IF NOT EXISTS alert_history (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, title TEXT, cities TEXT, threat TEXT)').run();

const TILE_SIZE = 256;
function latLonToPoint(lat, lon, zoom) {
    const scale = Math.pow(2, zoom);
    const x = (lon + 180) / 360 * scale * TILE_SIZE;
    const siny = Math.sin(lat * Math.PI / 180);
    const y = (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)) * scale * TILE_SIZE;
    return { x, y };
}


function getColorForThreat(threat) {
    switch (parseInt(threat)) {
        case 0: return "#FF0000"; // רקטות וטילים
        case 1: return "#9335ee"; // חומרים מסוכנים
        case 2: return "#FFD500"; // חדירת מחבלים
        case 3: return "#00FF55"; // רעידת אדמה
        case 4: return "#0080FF"; // צונאמי
        case 5: return "#FF8000"; // חדירת כלי טיס
        case 6:
        case 7: return "#ee35a8"; // לא קונבנציונלי / רדיולוגי
        default: return "#9e342e";
    }
}

async function generateCustomGraph(type, range, customFrom, customTo) {
    // 1. שליפת נתונים מהיסטוריית ההתרעות
    const response = await axios.get('https://www.tzevaadom.co.il/static/historical/all.json');
    let data = response.data;

    let startTime, endTime;
    const now = Math.floor(Date.now() / 1000);

    // 2. חישוב טווח זמנים (כולל תמיכה בתאריכים ידניים)
    if (customFrom) {
        const fromParts = customFrom.split('/');
        startTime = Math.floor(new Date(fromParts[2], fromParts[1] - 1, fromParts[0]).getTime() / 1000);
        if (customTo) {
            const toParts = customTo.split('/');
            endTime = Math.floor(new Date(toParts[2], toParts[1] - 1, toParts[0]).setHours(23, 59, 59) / 1000);
        } else {
            endTime = now;
        }
    } else {
        const ranges = {
            '24h': 24 * 60 * 60,
            '7d': 7 * 24 * 60 * 60,
            '30d': 30 * 24 * 60 * 60,
            '365d': 365 * 24 * 60 * 60
        };
        startTime = now - (ranges[range] || 86400);
        endTime = now;
    }

    // 3. סינון הנתונים לפי הזמן שנבחר
    const filteredData = data.filter(entry => entry[3] >= startTime && entry[3] <= endTime);
    if (filteredData.length === 0) return null;

    let labels = [];
    let values = [];
    let bgColors = '#9e342e';
    let chartType = 'bar';

    // 4. עיבוד הנתונים לפי סוג הגרף
    switch (type) {
        case 'cities':
            const cityCounts = {};
            filteredData.forEach(e => {
                e[2].forEach(city => {
                    cityCounts[city] = (cityCounts[city] || 0) + 1;
                });
            });
            const topCities = Object.entries(cityCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
            labels = topCities.map(i => i[0]);
            values = topCities.map(i => i[1]);
            break;

        case 'regions':
            const regionCounts = {};
            filteredData.forEach(e => {
                e[2].forEach(cityName => {
                    // שימוש ב-polygonsData כדי למצוא את האזור (area) של היישוב
                    const cityInfo = polygonsData[cityName.trim()];
                    if (cityInfo && cityInfo.info && cityInfo.info.area) {
                        const areaName = cityInfo.info.area;
                        regionCounts[areaName] = (regionCounts[areaName] || 0) + 1;
                    }
                });
            });
            // מיון האזורים לפי כמות התרעות (מהגבוה לנמוך) ולקיחת ה-15 המובילים
            const topRegions = Object.entries(regionCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
            labels = topRegions.map(i => i[0]);
            values = topRegions.map(i => i[1]);
            break;

        case 'hours':
            const hourCounts = Array(24).fill(0);
            filteredData.forEach(e => {
                const hour = new Date(e[3] * 1000).getHours();
                hourCounts[hour]++;
            });
            labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
            values = hourCounts;
            break;

        case 'types':
            const typeCounts = {};
            const threatNames = { 0: 'ירי טילים ורקטות', 1: 'אירוע חומרים מסוכנים', 2: 'חשש לחדירת מחבלים', 5: 'חדירת כלי טיס עוין' };
            filteredData.forEach(e => {
                typeCounts[e[1]] = (typeCounts[e[1]] || 0) + 1;
            });
            labels = Object.keys(typeCounts).map(code => (threatNames[code] || 'אחר'));
            values = Object.values(typeCounts);
            bgColors = Object.keys(typeCounts).map(code => getColorForThreat(code));
            break;

        case 'daily_count':
            chartType = 'line';
            const daily = {};
            filteredData.forEach(e => {
                const date = new Date(e[3] * 1000).toLocaleDateString('en-GB');
                daily[date] = (daily[date] || 0) + 1;
            });
            labels = Object.keys(daily);
            values = Object.values(daily);
            bgColors = '#FF0000';
            break;
    }

    // 5. בניית הגרף באמצעות Canvas
    const width = 800, height = 400;
    const chartCanvas = new ChartJSNodeCanvas({ width, height });

    const configuration = {
        type: chartType,
        data: {
            labels: labels,
            datasets: [{
                data: values,
                backgroundColor: bgColors,
                borderColor: chartType === 'line' ? '#FF0000' : 'transparent',
                borderWidth: 2,
                fill: chartType !== 'line',
                tension: 0.4
            }]
        },
        options: {
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { color: 'white' },
                    grid: { color: 'rgba(255,255,255,0.1)' }
                },
                x: {
                    ticks: { color: 'white' }
                }
            }
        }
    };

    return await chartCanvas.renderToBuffer(configuration);
}


async function getCachedTile(url) {
    const cached = db.prepare('SELECT data FROM tiles WHERE url = ?').get(url);
    if (cached) return loadImage(cached.data);
    try {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 2000 });
        const buffer = Buffer.from(res.data);
        db.prepare('INSERT OR IGNORE INTO tiles (url, data) VALUES (?, ?)').run(url, buffer);
        return loadImage(buffer);
    } catch { return null; }
}

async function generateMap(cityNames) {
    if (!Array.isArray(cityNames) || cityNames.length === 0) return null;

    const activePolygons = [];
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;

    cityNames.forEach(name => {
        const city = polygonsData[name.trim()];
        if (city && city.polygon) {
            activePolygons.push(city.polygon);
            if (city.info.lat < minLat) minLat = city.info.lat;
            if (city.info.lat > maxLat) maxLat = city.info.lat;
            if (city.info.lng < minLng) minLng = city.info.lng;
            if (city.info.lng > maxLng) maxLng = city.info.lng;
        }
    });

    if (activePolygons.length === 0) return null;

    const zoom = cityNames.length > 5 ? 9 : 11;

    const canvas = createCanvas(800, 500);
    const ctx = canvas.getContext('2d');
    const centerPoint = latLonToPoint((minLat + maxLat) / 2, (minLng + maxLng) / 2, zoom);

    const startX = Math.floor(centerPoint.x / TILE_SIZE) - 2;
    const startY = Math.floor(centerPoint.y / TILE_SIZE) - 2;

    for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
            const tx = startX + i, ty = startY + j;
            const url = `https://cartodb-basemaps-a.global.ssl.fastly.net/light_all/${zoom}/${tx}/${ty}.png`;
            const img = await getCachedTile(url);
            if (img) {
                const dx = Math.round((tx * TILE_SIZE) - centerPoint.x + 400);
                const dy = Math.round((ty * TILE_SIZE) - centerPoint.y + 250);
                ctx.drawImage(img, dx, dy);
            }
        }
    }

    activePolygons.forEach(poly => {
        ctx.strokeStyle = 'rgba(255, 0, 0, 0.9)';
        ctx.fillStyle = 'rgba(255, 0, 0, 0.45)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        poly.forEach((c, idx) => {
            const p = latLonToPoint(c[0], c[1], zoom);
            const x = Math.round(p.x - centerPoint.x + 400);
            const y = Math.round(p.y - centerPoint.y + 250);
            idx === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.closePath(); ctx.fill(); ctx.stroke();
    });

    try {
        const logo = await loadImage('./logo.png');
        ctx.drawImage(logo, 20, 20, 45, 45);
    } catch (e) {
        ctx.fillStyle = '#ff0000'; ctx.beginPath();
        ctx.arc(42, 42, 18, 0, Math.PI * 2); ctx.fill();
    }

    ctx.font = 'bold 22px Arial';
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'left';
    ctx.fillText('צופר – צבע אדום', 75, 52);

    const barW = 420;
    const barH = 38;
    const barX = 15;
    const barY = 500 - barH - 30;

    ctx.fillStyle = 'white';
    ctx.fillRect(barX, barY, barW, barH);

    ctx.strokeStyle = '#0038b8';
    ctx.lineWidth = 4;
    ctx.strokeRect(barX, barY, barW, barH);

    ctx.font = 'bold 13px Arial';
    ctx.fillStyle = '#0038b8';
    ctx.textAlign = 'center';
    ctx.fillText('צופר מחזקת את אזרחי ישראל וחיילי צה"ל - ביחד ננצח!', barX + (barW / 2), barY + 24);

    try {
        const flag = await loadImage('./flag.png');
        ctx.drawImage(flag, barX + 8, barY + 9, 26, 20);
        ctx.drawImage(flag, barX + barW - 34, barY + 9, 26, 20);
    } catch (e) { }

    return canvas.toBuffer();
}

const commands = [
    new SlashCommandBuilder().setName('setup').setDescription('הגדרת ערוץ ורול').addChannelOption(o => o.setName('channel').setRequired(true).setDescription('ערוץ')).addRoleOption(o => o.setName('role').setDescription('רול לתיוג')).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('time').setDescription('זמן התגוננות').addStringOption(o => o.setName('city').setRequired(true).setAutocomplete(true).setDescription('שם עיר')),
    new SlashCommandBuilder().setName('test').setDescription('בדיקה'),
    new SlashCommandBuilder().setName('suggest').setDescription('הצעה למפתח').addStringOption(o => o.setName('text').setRequired(true).setDescription('מה הצעתך?')),
    new SlashCommandBuilder().setName('status').setDescription('מצב בוט'),
    new SlashCommandBuilder().setName('admin_servers').setDescription('מפתח: רשימת שרתים לקובץ'),
    new SlashCommandBuilder()
        .setName('graph')
        .setDescription('הצגת נתונים סטטיסטיים וגרפים של התרעות')
        .addStringOption(o => o.setName('type')
            .setDescription('בחר את סוג הגרף')
            .setRequired(true)
            .addChoices(
                { name: 'שכיחות יישובים', value: 'cities' },
                { name: 'שכיחות אזורים', value: 'regions' },
                { name: 'התרעות לפי שעה', value: 'hours' },
                { name: 'סוגי התרעות', value: 'types' },
                { name: 'התרעות ביום לפי כמות יישובים', value: 'daily_count' }
            ))
        .addStringOption(o => o.setName('range')
            .setDescription('בחר טווח זמן')
            .setRequired(true)
            .addChoices(
                { name: 'יממה אחרונה', value: '24h' },
                { name: 'שבוע אחרון', value: '7d' },
                { name: 'חודש אחרון', value: '30d' },
                { name: 'שנה אחרונה', value: '365d' }
            )),

    new SlashCommandBuilder().setName('eval').setDescription('מפתח: הרצת קוד').addStringOption(o => o.setName('code').setRequired(true).setDescription('קוד')),
    new SlashCommandBuilder()
        .setName('broadcast')
        .setDescription('שליחת הודעה גלובלית לשרתים או לבעלים')
        .addStringOption(opt =>
            opt.setName('target')
                .setDescription('לאן לשלוח את ההודעה?')
                .setRequired(true)
                .addChoices(
                    { name: 'ערוצי עדכונים בשרתים', value: 'channels' },
                    { name: 'הודעה פרטית לבעלי השרתים (DM)', value: 'owners' }
                ))
        .addStringOption(opt => opt.setName('msg').setDescription('ההודעה לשליחה').setRequired(true))
        .addAttachmentOption(opt => opt.setName('media').setDescription('הוספת תמונה/וידאו (אופציונלי)'))].map(c => c.toJSON());


client.on('interactionCreate', async (int) => {
    if (int.isAutocomplete()) {
        const focused = int.options.getFocused().toLowerCase();
        const choices = Object.keys(polygonsData).filter(c => c.includes(focused)).slice(0, 25);
        return int.respond(choices.map(c => ({ name: c, value: c })));
    }

    if (!int.isChatInputCommand()) return;

    if (int.commandName === 'test') {
        try {
            await int.deferReply({ flags: [MessageFlags.Ephemeral] });
            const testCity = "ראשון לציון - מזרח";
            const cityData = polygonsData[testCity];
            if (!cityData) return await int.editReply(`❌ העיר "${testCity}" לא נמצאה.`);

            const buffer = await generateMap([testCity]);
            const attachment = new AttachmentBuilder(buffer, { name: 'map.png' });

            const testEmbed = new EmbedBuilder()
                .setTitle(`🚨 התרעה: ירי טילים ורקטות`)
                .setDescription(`**${testCity}**\nזמן התגוננות: **${cityData.info.countdown} שניות**\n\n🛡️ היכנסו למרחב המוגן ושהו בו 10 דקות.`)
                .setColor(0xFF0000)
                .setImage('attachment://map.png')
                .setTimestamp()
                .setFooter({ text: 'צופר - צבע אדום' });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel('📍 לצפייה במפה בזמן אמת').setURL('https://www.tzevaadom.co.il/').setStyle(ButtonStyle.Link)
            );

            await int.channel.send({
                content: "🔔 **בדיקת מערכת התרעות:**",
                embeds: [testEmbed],
                files: [attachment],
                components: [row]
            });

            await int.editReply(`✅ הבדיקה נשלחה בהצלחה!`);
        } catch (err) {
            if (int.deferred) await int.editReply("❌ חלה שגיאה בעיבוד הפקודה.");
        }
    }

    if (int.commandName === 'graph') {
        await int.deferReply();

        const type = int.options.getString('type');
        const range = int.options.getString('range');
        const fromDate = int.options.getString('from');
        const toDate = int.options.getString('to');

        try {
            // יצירת הגרף (הפונקציה שעדכנו קודם)
            const buffer = await generateCustomGraph(type, range, fromDate, toDate);

            if (!buffer) {
                return await int.editReply({ content: '❌ לא נמצאו נתונים לטווח הזמן שנבחר.', ephemeral: true });
            }

            // יצירת קובץ מצורף מה-Buffer
            const attachment = new AttachmentBuilder(buffer, { name: 'graph.png' });

            // בניית ה-Embed
            const embed = new EmbedBuilder()
                .setTitle(`📊 ניתוח נתוני התרעות: ${getFriendlyName(type)}`)
                .setDescription(`נתונים עבור טווח זמן: **${getFriendlyRange(range)}**${fromDate ? ` (מ-${fromDate}${toDate ? ` עד ${toDate}` : ''})` : ''}`)
                .setColor(0x9e342e) // צבע אדום כהה שתואם לגרף
                .setImage('attachment://graph.png') // קישור לתמונה המצורפת
                .setTimestamp()
                .setFooter({ text: 'מערכת ניתוח נתונים - צופר', iconURL: client.user.displayAvatarURL() });

            await int.editReply({
                embeds: [embed],
                files: [attachment]
            });

        } catch (error) {
            console.error("Graph Error:", error);
            await int.editReply({ content: '❌ אירעה שגיאה בעת יצירת הגרף. וודא שהתאריכים הוזנו בפורמט DD/MM/YYYY.', ephemeral: true });
        }
    }

    // פונקציות עזר להצגת שמות יפים ב-Embed
    function getFriendlyName(type) {
        const names = {
            'cities': 'שכיחות יישובים',
            'regions': 'שכיחות אזורים',
            'hours': 'התרעות לפי שעה',
            'types': 'סוגי התרעות',
            'daily_count': 'התרעות יומיות (קו מגמה)'
        };
        return names[type] || type;
    }

    function getFriendlyRange(range) {
        const ranges = {
            '24h': 'יממה אחרונה',
            '7d': 'שבוע אחרון',
            '30d': 'חודש אחרון',
            '365d': 'שנה אחרונה'
        };
        return ranges[range] || 'מותאם אישית';
    }

    // פונקציית עזר להפוך את ה-Value לשם יפה בעברית ב-Embed
    function getFriendlyName(type) {
        const names = {
            'cities': 'שכיחות יישובים',
            'regions': 'שכיחות אזורים',
            'hours': 'התרעות לפי שעה',
            'types': 'סוגי התרעות',
            'daily_count': 'התרעות יומיות'
        };
        return names[type];
    }

    if (int.commandName === 'setup') {
        const channel = int.options.getChannel('channel');
        const role = int.options.getRole('role');
        db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?, ?)').run(int.guildId, channel.id, role?.id || null);
        await int.reply(`✅ הערוץ ${channel} הוגדר בהצלחה.`);
    }

    if (int.commandName === 'time') {
        const city = int.options.getString('city');
        const data = polygonsData[city];
        if (!data) return int.reply("❌ עיר לא קיימת במאגר.");
        await int.reply(`🕒 ב**${city}** יש **${data.info.countdown} שניות** להגיע למרחב מוגן.`);
    }

    if (int.commandName === 'suggest') {
        const text = int.options.getString('text');

        try {
            const owner = await client.users.fetch(OWNER_ID);

            const embed = new EmbedBuilder()
                .setTitle('💡 הצעה חדשה')
                .setColor(0x00cc99)
                .addFields(
                    { name: 'שם', value: `${int.user.tag} (${int.user.id})` },
                    { name: 'שרת', value: `${int.guild?.name || 'פרטי'} (${int.guild?.id || 'N/A'})` },
                    { name: 'הצעה', value: text }
                )
                .setTimestamp();

            await owner.send({ embeds: [embed] });

            await int.reply({
                content: "✅ ההצעה נשלחה למפתח!",
                ephemeral: true
            });

        } catch (err) {
            console.error(err);

            await int.reply({
                content: "❌ לא הצלחתי לשלוח למפתח (ייתכן ש־DM סגור).",
                ephemeral: true
            });
        }
    }

    if (int.commandName === 'status') {
        await int.reply(`🟢 פעיל ב-${client.guilds.cache.size} שרתים. פינג: ${client.ws.ping}ms`);
    }

    if (['admin_servers', 'broadcast', 'eval'].includes(int.commandName)) {
        if (int.user.id !== OWNER_ID) return int.reply({ content: "🚫 גישה חסומה.", ephemeral: true });

        if (int.commandName === 'admin_servers') {
            const { EmbedBuilder } = require('discord.js');

            const embed = new EmbedBuilder()
                .setTitle('📊 Servers List')
                .setColor(0x2b2d31);

            let description = "";

            for (const g of client.guilds.cache.values()) {
                let inviteLink = "No invite";

                try {
                    const invites = await g.invites.fetch();
                    const invite = invites.first();
                    if (invite) {
                        inviteLink = `https://discord.gg/${invite.code}`;
                    }
                } catch (err) {
                    inviteLink = "No permission";
                }

                description += `**${g.name}**\n`;
                description += `👥 ${g.memberCount} members\n`;
                description += `🔗 ${inviteLink}\n\n`;
            }

            if (description.length > 4000) {
                description = description.slice(0, 3900) + "\n⚠️ Too many servers...";
            }

            embed.setDescription(description);

            await int.reply({ embeds: [embed], ephemeral: true });
        }

        if (int.commandName === 'broadcast') {
            // בדיקת הרשאת בעלים
            if (int.user.id !== OWNER_ID) {
                return int.reply({ content: "🚫 גישה חסומה. פקודה זו מיועדת לבעל הבוט בלבד.", ephemeral: true });
            }

            const targetType = int.options.getString('target');
            const msg = int.options.getString('msg');
            const media = int.options.getAttachment('media');

            await int.deferReply({ ephemeral: true });

            // יצירת האמבד המרכזי
            const broadcastEmbed = new EmbedBuilder()
                .setTitle(targetType === 'owners' ? '📢 הודעה אישית מבעלי הבוט' : '📢 הודעת מערכת רשמית')
                .setDescription(msg)
                .setColor(targetType === 'owners' ? 0xFFAC33 : 0x0099FF) // כתום לבעלים, כחול לערוצים
                .setTimestamp()
                .setFooter({ text: `נשלח על ידי ${int.user.username}`, iconURL: int.user.displayAvatarURL() });

            // אם צורפה מדיה (תמונה/וידאו), נוסיף אותה לאמבד
            if (media) {
                broadcastEmbed.setImage(media.url);
            }

            let success = 0;
            let failed = 0;

            if (targetType === 'channels') {
                // שליחה לערוצים מה-Database
                const targets = db.prepare('SELECT channelId FROM settings').all();

                // שימוש ב-Promise.all לשליחה מהירה לערוצים
                await Promise.all(targets.map(async (t) => {
                    try {
                        const ch = await client.channels.fetch(t.channelId).catch(() => null);
                        if (ch) {
                            await ch.send({ embeds: [broadcastEmbed] });
                            success++;
                        } else { failed++; }
                    } catch { failed++; }
                }));
            } else {
                // שליחה לבעלי השרתים ב-DM
                const guilds = client.guilds.cache.values();

                for (const guild of guilds) {
                    try {
                        const owner = await guild.fetchOwner().catch(() => null);
                        if (owner) {
                            await owner.send({
                                content: `שלום ${owner.user.username}, קיבלת הודעה בנוגע לשרת שלך **${guild.name}**:`,
                                embeds: [broadcastEmbed]
                            });
                            success++;
                        } else { failed++; }
                    } catch (err) {
                        // בדרך כלל DM סגור
                        failed++;
                    }
                }
            }

            await int.editReply({
                content: `✅ השידור הושלם בפורמט Embed!\n🎯 יעד: **${targetType === 'owners' ? 'בעלי שרתים (DM)' : 'ערוצי עדכונים'}**\n🟢 נשלחו בהצלחה: ${success}\n🔴 נכשלו: ${failed}`
            });
        }

        if (int.commandName === 'eval') {
            try {
                let res = eval(int.options.getString('code'));
                await int.reply({ content: `\`\`\`js\n${res}\n\`\`\``, ephemeral: true });
            } catch (e) { await int.reply({ content: `Error: ${e}`, ephemeral: true }); }
        }
    }
});

let lastAlertId = null;
let lastAlertCities = "";
let lastAlertTime = 0;

async function checkAlerts() {
    try {
        const res = await axios.get(ALERT_API, {
            headers: { 'Referer': 'https://www.oref.org.il/', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'Mozilla/5.0' },
            timeout: 2000
        });

        let data = res.data;
        // פתרון שגיאות BOM שמונעות מזיהוי ה-JSON ב-axios
        if (typeof data === 'string') {
            data = data.replace(/^\uFEFF/, '').trim();
            if (!data) return;
            try { data = JSON.parse(data); } catch (e) { return; }
        }

        if (!data || !Array.isArray(data.data) || data.data.length === 0) return;

        const currentCities = data.data.slice().sort().join(',');
        const now = Date.now();

        // מנגנון מניעת כפילויות חכם - בודק גם את מזהה ההתראה וגם אם אותם יישובים בדיוק חזרו ב-2 הדקות האחרונות
        if ((data.id === lastAlertId) || (currentCities === lastAlertCities && (now - lastAlertTime < 120000))) {
            return;
        }

        lastAlertId = data.id;
        lastAlertCities = currentCities;
        lastAlertTime = now;

        const cities = data.data;
        const alertTitle = data.title || "התרעה";

        const buffer = await generateMap(cities);
        if (!buffer) return;

        let embedColor = 0xFF0000;
        let description = `**ערים בטווח סכנה:**\n${cities.join(', ')}`;

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('למפה בזמן אמת').setURL('https://www.tzevaadom.co.il/').setStyle(ButtonStyle.Link),
            new ButtonBuilder().setLabel('הנחיות מצילות חיים').setURL('https://www.oref.org.il/12487-he/Pakar.aspx').setStyle(ButtonStyle.Link)
        );

        const embed = new EmbedBuilder().setTitle(alertTitle).setDescription(description).setColor(embedColor).setImage('attachment://map.png').setTimestamp().setFooter({ text: 'צופר - צבע אדום' });

        const servers = db.prepare('SELECT * FROM settings').all();

        for (const s of servers) {
            const ch = await client.channels.fetch(s.channelId).catch(() => null);

            if (ch) {
                const mention = s.roleId ? `<@&${s.roleId}>` : '';
                ch.send({ content: mention, embeds: [embed], files: [new AttachmentBuilder(buffer, { name: 'map.png' })], components: [row] }).catch(() => { });

            }
        }
    } catch (e) { }
}


client.once('ready', async () => {
    console.log(`🚀 ${client.user.tag} Online!`);
    setInterval(() => {
        const servers = client.guilds.cache.size;
        const totalUsers = client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);

        const activities = [
            `${servers} שרתים`,
            `${totalUsers} משתמשים`,
            `צופר מחזקת את אזרחי ישראל`,
            `ביחד ננצח!`,
            `שומרים על העורף 🇮🇱`
        ];

        const randomActivity = activities[Math.floor(Math.random() * activities.length)];
        client.user.setPresence({
            activities: [{
                name: randomActivity,
                type: ActivityType.Watching
            }],
            status: PresenceUpdateStatus.DoNotDisturb,
        });

    }, 10000);

    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('✅ commands');
    } catch (error) {
        console.error('❌ commands', error);
    }

    setInterval(checkAlerts, 5000);
});

client.login(TOKEN);
