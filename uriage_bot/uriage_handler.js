// e:\共有フォルダ\svml_zimu_bot-main\svml_zimu_bot-main\uriage_bot\uriage_handler.js

const {
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits,
} = require('discord.js');
const { readJsonFromGCS, saveJsonToGCS } = require('../common/gcs/gcsUtils');
const { DateTime } = require('luxon');

const SETTINGS_FILE_PATH = (guildId) => `data/${guildId}/${guildId}.json`;

/**
 * ロール選択メニューの操作を処理
 * @param {import('discord.js').RoleSelectMenuInteraction} interaction
 */
async function handleRoleSelectMenu(interaction) {
    await interaction.deferUpdate();

    const guildId = interaction.guildId;
    const selectedRoleIds = interaction.values;
    const settingsPath = SETTINGS_FILE_PATH(guildId);

    try {
        const currentSettings = await readJsonFromGCS(settingsPath) || {};
        const newSettings = {
            ...currentSettings,
            approvalRoleIds: selectedRoleIds,
        };

        await saveJsonToGCS(settingsPath, newSettings);

        const embed = new EmbedBuilder()
            .setTitle('✅ 設定完了')
            .setColor(0x57F287);

        if (selectedRoleIds.length > 0) {
            const roleMentions = selectedRoleIds.map(id => `<@&${id}>`).join(', ');
            embed.setDescription(`売上報告の承認ロールを以下に設定しました。\n${roleMentions}`);
        } else {
            embed.setDescription('売上報告の承認ロールをすべて解除しました。');
        }

        await interaction.editReply({ embeds: [embed], components: [] });

    } catch (error) {
        console.error('❌ 承認ロール設定の保存中にエラー:', error);
        await interaction.editReply({
            content: 'エラーが発生し、設定を保存できませんでした。',
            embeds: [],
            components: []
        });
    }
}

/**
 * 数値を3桁区切りの文字列にフォーマットします
 * @param {number} num - フォーマットする数値
 * @returns {string} - フォーマット後の文字列
 */
function formatNumber(num) {
    if (typeof num !== 'number' || isNaN(num)) return '0';
    return new Intl.NumberFormat('ja-JP').format(num);
}

/**
 * 売上報告モーダルの送信を処理します
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleModalSubmit(interaction) {
    const isEdit = interaction.customId.startsWith('sales_report_edit_modal');
    let originalMessageId = null;

    // 編集の場合は、モーダルのcustomIdから元のメッセージIDを抽出します
    if (isEdit) {
        const parts = interaction.customId.split('_');
        originalMessageId = parts.pop();
    }

    // 新規・編集で応答方法を分ける
    // 新規の場合はチャンネルに新しいメッセージとして投稿
    // 編集の場合は元のメッセージを更新し、ephemeralなメッセージで完了を通知
    await interaction.deferReply({ ephemeral: isEdit });

    try {
        const guildId = interaction.guildId;

        // モーダルからデータを取得
        const salesDateStr = interaction.fields.getTextInputValue('sales_date');
        const totalSalesStr = interaction.fields.getTextInputValue('total_sales');
        const cashSalesStr = interaction.fields.getTextInputValue('cash_sales');
        const cardSalesStr = interaction.fields.getTextInputValue('card_sales');
        const expensesStr = interaction.fields.getTextInputValue('expenses');

        // 入力値のパースとバリデーション
        const totalSales = parseInt(totalSalesStr.replace(/,/g, ''), 10);
        const cashSales = parseInt(cashSalesStr.replace(/,/g, ''), 10);
        const cardSales = parseInt(cardSalesStr.replace(/,/g, ''), 10);
        const expenses = parseInt(expensesStr.replace(/,/g, ''), 10);

        if ([totalSales, cashSales, cardSales, expenses].some(isNaN)) {
            await interaction.editReply({ content: '⚠️ 金額は半角数字で入力してください。', ephemeral: true });
            return;
        }

        // 日付のパース (例: "7/7" -> "2024-07-07")
        let salesDate = DateTime.fromFormat(salesDateStr, 'M/d', { zone: 'Asia/Tokyo' }).set({ year: DateTime.now().year });
        if (!salesDate.isValid) {
            await interaction.editReply({ content: '⚠️ 日付の形式が正しくありません。(例: 7/7)', ephemeral: true });
            return;
        }
        const dateForFilename = salesDate.toFormat('yyyy-MM-dd');

        // GCSに保存するデータを作成
        const reportData = {
            date: salesDate.toISODate(),
            totalSales,
            cashSales,
            cardSales,
            expenses,
            reporterId: interaction.user.id,
            reporterTag: interaction.user.tag,
            reportedAt: DateTime.now().toISO(),
        };

        const dataPath = `data/${guildId}/uriagehoukoku_${dateForFilename}.json`;

        // 既存データがあればバックアップ
        try {
            const existingData = await readJsonFromGCS(dataPath);
            if (existingData && existingData.reportedAt) {
                const backupTimestamp = DateTime.fromISO(existingData.reportedAt).toFormat('yyyyMMddHHmmss');
                const backupPath = `logs/${guildId}/uriagehoukoku_${dateForFilename}_${backupTimestamp}.json`;
                await saveJsonToGCS(backupPath, existingData);
            }
        } catch (error) {
            if (error.code !== 404) console.warn(`GCSからの既存ファイル読み込み中に無視できないエラー:`, error);
        }

        // 新しいデータを保存
        await saveJsonToGCS(dataPath, reportData);

        // Embedを作成
        const remainder = totalSales - cashSales - expenses;
        const embed = new EmbedBuilder()
            .setTitle(`📊 売上報告 (${salesDate.toFormat('M/d')})`)
            .setColor(0x0099FF)
            .addFields(
                { name: '総売り', value: `¥${formatNumber(totalSales)}`, inline: true },
                { name: '現金', value: `¥${formatNumber(cashSales)}`, inline: true },
                { name: 'カード', value: `¥${formatNumber(cardSales)}`, inline: true },
                { name: '諸経費', value: `¥${formatNumber(expenses)}`, inline: true },
                { name: '残金', value: `¥${formatNumber(remainder)}`, inline: true },
            )
            .setFooter({ text: `報告者: ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
            .setTimestamp();

        // 承認/却下/修正ボタンを作成
        const actionRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`uriage_approve_${dateForFilename}`)
                    .setLabel('承認')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`uriage_reject_${dateForFilename}`)
                    .setLabel('却下')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('sales_report_edit') // 修正ボタンは既存のハンドラを再利用
                    .setLabel('修正')
                    .setStyle(ButtonStyle.Secondary)
            );

        if (isEdit) {
            // 元のメッセージを編集
            const originalMessage = await interaction.channel.messages.fetch(originalMessageId);
            await originalMessage.edit({ embeds: [embed], components: [actionRow] });
            // ephemeralな応答を編集して完了を通知
            await interaction.editReply({ content: '✅ 報告を更新しました。' });
        } else {
            // 新しいメッセージとして投稿
            await interaction.editReply({ embeds: [embed], components: [actionRow] });
        }
    } catch (error) {
        console.error('❌ 売上報告モーダルの処理中にエラー:', error);
        const errorMessage = 'エラーが発生し、報告を処理できませんでした。';
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: errorMessage, embeds: [], components: [] });
        }
    }
}

/**
 * 売上報告の承認・却下を処理します
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {boolean} isApproved - 承認されたかどうか
 */
async function handleApproval(interaction, isApproved) {
    await interaction.deferUpdate();

    const guildId = interaction.guildId;
    const member = interaction.member;

    // 承認ロールを持っているか、または管理者かを確認
    const settingsPath = SETTINGS_FILE_PATH(guildId);
    const settings = await readJsonFromGCS(settingsPath) || {};
    const approvalRoleIds = settings.approvalRoleIds || [];

    let hasPermission = false;
    if (approvalRoleIds.length > 0) {
        hasPermission = member.roles.cache.some(role => approvalRoleIds.includes(role.id));
    } else {
        // ロール未設定の場合はサーバー管理者のみが操作可能
        hasPermission = member.permissions.has(PermissionFlagsBits.Administrator);
    }

    if (!hasPermission) {
        await interaction.followUp({ content: '⚠️ この操作を行う権限がありません。', ephemeral: true });
        return;
    }

    // customIdから日付を抽出
    const dateForFilename = interaction.customId.split('_').pop();
    const dataPath = `data/${guildId}/uriagehoukoku_${dateForFilename}.json`;

    try {
        const reportData = await readJsonFromGCS(dataPath);
        if (!reportData) {
            await interaction.editReply({ content: 'エラー: 元の報告データが見つかりませんでした。', components: [] });
            return;
        }

        // 承認情報をデータに追記
        reportData.approval = {
            status: isApproved ? 'approved' : 'rejected',
            approverId: interaction.user.id,
            approverTag: interaction.user.tag,
            approvedAt: DateTime.now().toISO(),
        };
        await saveJsonToGCS(dataPath, reportData);

        // Embedを更新
        const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
        originalEmbed.setColor(isApproved ? 0x57F287 : 0xED4245) // Green: Approved, Red: Rejected
            .setFields(interaction.message.embeds[0].fields.filter(field => field.name !== 'ステータス')) // 既存のステータスを削除
            .addFields({
                name: 'ステータス',
                value: `${isApproved ? '✅ 承認済み' : '❌ 却下済み'} (by ${interaction.user.tag})`,
            });

        // ボタンを更新（承認・却下のみ無効化）
        const updatedButtons = new ActionRowBuilder();
        interaction.message.components[0].components.forEach(button => {
            const newButton = ButtonBuilder.from(button);
            if (button.customId.startsWith('uriage_approve_') || button.customId.startsWith('uriage_reject_')) {
                newButton.setDisabled(true);
            }
            updatedButtons.addComponents(newButton);
        });

        await interaction.editReply({ embeds: [originalEmbed], components: [updatedButtons] });

    } catch (error) {
        console.error(`❌ 報告の${isApproved ? '承認' : '却下'}処理中にエラー:`, error);
        await interaction.followUp({ content: 'エラーが発生し、処理を完了できませんでした。', ephemeral: true });
    }
}

/**
 * 売上報告の承認・却下を処理します
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {boolean} isApproved - 承認されたかどうか
 */
async function handleApproval(interaction, isApproved) {
    await interaction.deferUpdate();

    const guildId = interaction.guildId;
    const member = interaction.member;

    // 承認ロールを持っているか、または管理者かを確認
    const settingsPath = SETTINGS_FILE_PATH(guildId);
    const settings = await readJsonFromGCS(settingsPath) || {};
    const approvalRoleIds = settings.approvalRoleIds || [];

    let hasPermission = false;
    if (approvalRoleIds.length > 0) {
        hasPermission = member.roles.cache.some(role => approvalRoleIds.includes(role.id));
    } else {
        // ロール未設定の場合はサーバー管理者のみが操作可能
        hasPermission = member.permissions.has(PermissionFlagsBits.Administrator);
    }

    if (!hasPermission) {
        await interaction.followUp({ content: '⚠️ この操作を行う権限がありません。', ephemeral: true });
        return;
    }

    // customIdから日付を抽出
    const dateForFilename = interaction.customId.split('_').pop();
    const dataPath = `data/${guildId}/uriagehoukoku_${dateForFilename}.json`;

    try {
        const reportData = await readJsonFromGCS(dataPath);
        if (!reportData) {
            await interaction.editReply({ content: 'エラー: 元の報告データが見つかりませんでした。', components: [] });
            return;
        }

        // 承認情報をデータに追記
        reportData.approval = {
            status: isApproved ? 'approved' : 'rejected',
            approverId: interaction.user.id,
            approverTag: interaction.user.tag,
            approvedAt: DateTime.now().toISO(),
        };
        await saveJsonToGCS(dataPath, reportData);

        // Embedを更新
        const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
        originalEmbed.setColor(isApproved ? 0x57F287 : 0xED4245) // Green: Approved, Red: Rejected
            .setFields(interaction.message.embeds[0].fields.filter(field => field.name !== 'ステータス')) // 既存のステータスを削除
            .addFields({
                name: 'ステータス',
                value: `${isApproved ? '✅ 承認済み' : '❌ 却下済み'} (by ${interaction.user.tag})`,
            });

        // ボタンを更新（承認・却下のみ無効化）
        const updatedButtons = new ActionRowBuilder();
        interaction.message.components[
/**
 * 売上報告モーダルを表示します
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object | null} [reportData=null] - 編集時にモーダルに事前入力するデータ
 * @param {string | null} [messageId=null] - 編集対象のメッセージID
 */
async function showSalesReportModal(interaction, reportData = null, messageId = null) {
    const isEdit = !!reportData;
    const dateForId = isEdit ? DateTime.fromISO(reportData.date).toFormat('yyyy-MM-dd') : '';

    const modal = new ModalBuilder()
        .setCustomId(isEdit ? `sales_report_edit_modal_${dateForId}_${messageId}` : 'sales_report_modal')
        .setTitle(isEdit ? '売上報告の修正' : '売上報告');

    // 各入力フィールドを定義
    const dateInput = new TextInputBuilder()
        .setCustomId('sales_date')
        .setLabel('日付 (例: 7/7)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(isEdit ? '' : '7/7')
        .setValue(isEdit ? DateTime.fromISO(reportData.date).toFormat('M/d') : '');

    const totalSalesInput = new TextInputBuilder()
        .setCustomId('total_sales')
        .setLabel('総売り (半角数字)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(isEdit ? '' : '300000')
        .setValue(isEdit ? String(reportData.totalSales) : '');

    const cashInput = new TextInputBuilder()
        .setCustomId('cash_sales')
        .setLabel('現金 (半角数字)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(isEdit ? '' : '150000')
        .setValue(isEdit ? String(reportData.cashSales) : '');

    const cardInput = new TextInputBuilder()
        .setCustomId('card_sales')
        .setLabel('カード (半角数字)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(isEdit ? '' : '150000')
        .setValue(isEdit ? String(reportData.cardSales) : '');

    const expensesInput = new TextInputBuilder()
        .setCustomId('expenses')
        .setLabel('諸経費 (半角数字)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(isEdit ? '' : '10000')
        .setValue(isEdit ? String(reportData.expenses) : '');

    // モーダルに行として追加
    modal.addComponents(
        new ActionRowBuilder().addComponents(dateInput),
        new ActionRowBuilder().addComponents(totalSalesInput),
        new ActionRowBuilder().addComponents(cashInput),
        new ActionRowBuilder().addComponents(cardInput),
        new ActionRowBuilder().addComponents(expensesInput)
    );

    await interaction.showModal(modal);
}

/**
 * 売上報告の修正処理
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleEditSalesReport(interaction) {
    const message = interaction.message;
    const embed = message.embeds[0];

    if (!embed || !embed.title) {
        return interaction.reply({ content: '⚠️ 修正対象の報告埋め込みが見つかりません。', ephemeral: true });
    }

    // タイトルから日付を抽出: "📊 売上報告 (7/7)" -> "7/7"
    const dateMatch = embed.title.match(/\((\d{1,2}\/\d{1,2})\)/);
    if (!dateMatch || !dateMatch[1]) {
        return interaction.reply({ content: '⚠️ 報告埋め込みから日付を特定できませんでした。', ephemeral: true });
    }

    const salesDateStr = dateMatch[1];
    const salesDate = DateTime.fromFormat(salesDateStr, 'M/d', { zone: 'Asia/Tokyo' }).set({ year: DateTime.now().year });
    const dateForFilename = salesDate.toFormat('yyyy-MM-dd');
    const dataPath = `data/${interaction.guildId}/uriagehoukoku_${dateForFilename}.json`;

    try {
        const existingData = await readJsonFromGCS(dataPath);
        if (!existingData) {
            return interaction.reply({ content: '⚠️ GCSから元データが見つかりませんでした。新規で報告してください。', ephemeral: true });
        }

        // 既存データをセットしてモーダルを表示
        await showSalesReportModal(interaction, existingData, message.id);

    } catch (error) {
        console.error('❌ 報告修正データの読み込み中にエラー:', error);
        await interaction.reply({ content: 'エラーが発生し、修正を開始できませんでした。', ephemeral: true });
    }
}

module.exports = {
    /**
     * uriage_bot関連のコンポーネントインタラクションを処理します。
     * @param {import('discord.js').Interaction} interaction
     * @param {import('discord.js').Client} client
     * @returns {Promise<boolean>} - インタラクションを処理した場合はtrue、それ以外はfalse
     */
    async execute(interaction, client) {
        // このハンドラはコンポーネント操作のみを対象とします
        if (!interaction.isMessageComponent() && !interaction.isModalSubmit()) {
            return false;
        }

        const customId = interaction.customId;

        // customIdに応じて処理を振り分け
        if (customId === 'select_approval_roles') {
            await handleRoleSelectMenu(interaction);
            return true;
        }

        if (customId === 'sales_report') {
            await showSalesReportModal(interaction);
            return true;
        }

        if (customId === 'sales_report_edit') {
            await handleEditSalesReport(interaction);
            return true;
        }

        if (customId.startsWith('uriage_approve_')) {
            await handleApproval(interaction, true);
            return true;
        }

        if (customId.startsWith('uriage_reject_')) {
            await handleApproval(interaction, false);
            return true;
        }

        if (interaction.isModalSubmit() && (customId === 'sales_report_modal' || customId.startsWith('sales_report_edit_modal'))) {
            await handleModalSubmit(interaction);
            return true;
        }

        // このハンドラでは処理されなかった
        return false;
    }
};