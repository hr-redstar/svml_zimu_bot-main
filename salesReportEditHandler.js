const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { readJsonFromGCS, saveJsonToGCS, deleteGCSFile } = require('../../../utils/gcs');
const { parseAndValidateReportData } = require('../../../utils/salesReportUtils');

module.exports = {
  // customIdが 'edit_sales_report_modal_' で始まるインタラクションにマッチ
  customId: /^edit_sales_report_modal_(\d{4}-\d{2}-\d{2})_(\d+)$/,
  async execute(interaction) {
    const match = interaction.customId.match(this.customId);
    const [, originalDate, userId] = match;

    const { data, error } = parseAndValidateReportData(interaction);
    if (error) { return interaction.reply({ content: error, ephemeral: true }); }
    const { normalizedDate, totalNum, cashNum, cardNum, expenseNum, balance } = data;

    // --- 新しいEmbedを作成 ---
    const embed = new EmbedBuilder()
      .setTitle('📈 売上報告 (修正済み)')
      .setColor(0xffa500) // オレンジ色で修正を表現
      .setDescription(`${interaction.user} さんによって修正されました。`)
      .addFields(
        { name: '日付', value: normalizedDate, inline: true },
        { name: '総売り', value: `¥${totalNum.toLocaleString()}`, inline: true },
        { name: '現金', value: `¥${cashNum.toLocaleString()}`, inline: true },
        { name: 'カード', value: `¥${cardNum.toLocaleString()}`, inline: true },
        { name: '諸経費', value: `¥${expenseNum.toLocaleString()}`, inline: true },
        { name: '残金', value: `¥${balance.toLocaleString()}`, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: `修正者: ${interaction.user.username}` });

    // --- customIdを更新した新しいボタンを作成 ---
    const newButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('sales_report') // これは新規報告用パネルのボタンID
        .setLabel('次の売上を報告')
        .setStyle(ButtonStyle.Success)
    );

    // --- GCSとDiscordメッセージの更新処理 ---
    const guildId = interaction.guildId;
    const originalFilePath = `data/sales_reports/${guildId}/uriage-houkoku-${originalDate}-${userId}.json`;
    const newFilePath = `data/sales_reports/${guildId}/uriage-houkoku-${normalizedDate}-${userId}.json`;

    try {
      const originalData = await readJsonFromGCS(originalFilePath);
      if (!originalData || !originalData.messageId) {
        return interaction.reply({ content: '元の報告データが見つからないか、データが破損しているため、修正できませんでした。', ephemeral: true });
      }

      if (originalFilePath !== newFilePath) {
        await deleteGCSFile(originalFilePath);
      }

      const newSalesData = { ...originalData, 入力者: interaction.user.username, userId: userId, 日付: normalizedDate, 総売り: totalNum, 現金: cashNum, カード: cardNum, 諸経費: expenseNum, 残金: balance, 修正日時: new Date().toISOString(), 修正者: interaction.user.username, 修正者ID: interaction.user.id, };
      await saveJsonToGCS(newFilePath, newSalesData);

      const messageToEdit = await interaction.channel.messages.fetch(originalData.messageId);

      let newContent = messageToEdit.content;
      if (originalDate !== normalizedDate) {
        newContent = newContent.replace(`申請日：${originalDate}`, `申請日：${normalizedDate}`);
      }
      newContent = newContent.replace(/✅『承認 \(\d+\/\d+\)』/, '⚠️『修正済・再承認待ち』');

      await messageToEdit.edit