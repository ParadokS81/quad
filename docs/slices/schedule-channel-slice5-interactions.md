# Slice 5: Interactive Availability — Edit Day + Clear Week (Quad)

> **Project**: Quad (`/home/paradoks/projects/quake/quad/`)
> **Effort**: Medium (~1 hour)
> **Dependencies**: Slice 4
> **PRD**: `/home/paradoks/projects/quake/SCHEDULE-CHANNEL-PRD.md`

## Goal

Players can edit their availability and clear their week directly from Discord via the persistent schedule message.

---

## Changes

### 1. `src/modules/availability/interactions.ts` — All interaction handlers

**Registration** (in `registerEvents`):
```typescript
client.on(Events.InteractionCreate, async (interaction) => {
    // Route buttons
    if (interaction.isButton() && interaction.customId.startsWith('avail:')) {
        await handleButton(interaction);
        return;
    }
    // Route select menus
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('avail:')) {
        await handleSelectMenu(interaction);
        return;
    }
});
```

**Custom ID scheme:**
- `avail:clearWeek:{teamId}` — -Me This Week button
- `avail:editDay:{teamId}` — Edit day select menu (on persistent message)
- `avail:editSlots:{teamId}:{cetDay}` — Time slot multi-select (on ephemeral)
- `avail:editAnother:{teamId}` — Edit another day select (on confirmation ephemeral)

Encoding `teamId` in the custom ID lets the handler know which team without a lookup. Discord custom IDs max 100 chars — team IDs are ~20 chars, so plenty of room.

---

### 2. Edit Day Flow

**Step 1: User selects a day from `avail:editDay:{teamId}` select menu**

The select menu on the persistent message shows 7 days:
```
Option value: "mon"  Label: "Mon 16th"         Description: ""
Option value: "tue"  Label: "Tue 17th"         Description: "you: 21:30-23:00"
Option value: "wed"  Label: "Wed 18th (past)"  Description: ""
...
```

Handler:
```typescript
async function handleDaySelect(interaction: StringSelectMenuInteraction) {
    const teamId = extractTeamId(interaction.customId);
    const cetDay = interaction.values[0];  // e.g. "fri"

    // 1. Resolve Discord user → Firebase UID
    const user = await resolveUser(interaction.user.id, teamId);
    if (!user) return replyNotLinked(interaction, teamId);

    // 2. Check if past day
    if (isDayPast(cetDay, getCurrentWeekId())) {
        return interaction.reply({ content: 'This day has already passed.', flags: MessageFlags.Ephemeral });
    }

    // 3. Get current slots for this day
    const currentSlots = getCurrentUserSlots(teamId, user.uid, cetDay);

    // 4. Build time slot multi-select
    const CET_TIMES = ['1900','1930','2000','2030','2100','2130','2200','2230','2300'];
    const options = CET_TIMES.map(time => ({
        label: `${formatCetTime(time)} CET`,
        value: time,
        default: currentSlots.includes(time),  // pre-check current slots
    }));

    const select = new StringSelectMenuBuilder()
        .setCustomId(`avail:editSlots:${teamId}:${cetDay}`)
        .setPlaceholder('Select times...')
        .setMinValues(0)       // allow deselecting all
        .setMaxValues(options.length)
        .addOptions(options);

    const dayLabel = formatDayLabel(cetDay, getCurrentWeekId());  // "Friday Feb 21st"

    await interaction.reply({
        content: `**${dayLabel}**\nSelect which times you're available:`,
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        flags: MessageFlags.Ephemeral,
    });
}
```

**Step 2: User modifies selections from `avail:editSlots:{teamId}:{cetDay}`**

```typescript
async function handleSlotSelect(interaction: StringSelectMenuInteraction) {
    const [, , teamId, cetDay] = interaction.customId.split(':');
    const selectedCetTimes = interaction.values;  // e.g. ['2000','2030','2100','2130']

    const user = await resolveUser(interaction.user.id, teamId);
    if (!user) return replyNotLinked(interaction, teamId);

    // Get current state for diff
    const currentSlots = getCurrentUserSlots(teamId, user.uid, cetDay);

    // Diff
    const toAdd = selectedCetTimes.filter(t => !currentSlots.includes(t));
    const toRemove = currentSlots.filter(t => !selectedCetTimes.includes(t));

    // Skip if no changes
    if (toAdd.length === 0 && toRemove.length === 0) {
        return interaction.update({ content: 'No changes made.', components: [] });
    }

    // Build Firestore update
    const weekId = getCurrentWeekId();
    const docId = `${teamId}_${weekId}`;
    const updateData: Record<string, any> = {
        lastUpdated: FieldValue.serverTimestamp(),
    };

    for (const cetTime of toAdd) {
        const utcSlotId = cetToUtcSlotId(cetDay, cetTime);
        updateData[`slots.${utcSlotId}`] = FieldValue.arrayUnion(user.uid);
        updateData[`unavailable.${utcSlotId}`] = FieldValue.arrayRemove(user.uid);
    }
    for (const cetTime of toRemove) {
        const utcSlotId = cetToUtcSlotId(cetDay, cetTime);
        updateData[`slots.${utcSlotId}`] = FieldValue.arrayRemove(user.uid);
    }

    // Write — use set({merge:true}) in case doc doesn't exist yet
    try {
        const docRef = db.collection('availability').doc(docId);
        const doc = await docRef.get();
        if (!doc.exists) {
            await docRef.set({ teamId, weekId, slots: {}, unavailable: {}, ...updateData });
        } else {
            await docRef.update(updateData);
        }
    } catch (err) {
        return interaction.update({ content: 'Failed to update — try again.', components: [] });
    }

    // Confirmation with diff summary
    const addedStr = toAdd.map(t => formatCetTime(t)).join(', ');
    const removedStr = toRemove.map(t => formatCetTime(t)).join(', ');
    let summary = `✓ **${formatDayName(cetDay)}** updated\n`;
    if (addedStr) summary += `Added: ${addedStr}\n`;
    if (removedStr) summary += `Removed: ${removedStr}\n`;

    // Offer "Edit another day" select
    const editAnother = buildDaySelectMenu(`avail:editAnother:${teamId}`, teamId);

    await interaction.update({
        content: summary,
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(editAnother)],
    });
}
```

**Step 3: "Edit another day"** — `avail:editAnother:{teamId}` is handled identically to `avail:editDay:{teamId}` (same handler, just different custom ID origin).

---

### 3. Clear Week Flow

**`avail:clearWeek:{teamId}` button handler:**

```typescript
async function handleClearWeek(interaction: ButtonInteraction) {
    const teamId = extractTeamId(interaction.customId);

    const user = await resolveUser(interaction.user.id, teamId);
    if (!user) return replyNotLinked(interaction, teamId);

    const weekId = getCurrentWeekId();
    const docId = `${teamId}_${weekId}`;
    const docRef = db.collection('availability').doc(docId);
    const doc = await docRef.get();

    if (!doc.exists) {
        return interaction.reply({
            content: 'You have no availability set this week.',
            flags: MessageFlags.Ephemeral,
        });
    }

    const data = doc.data();
    const updateData: Record<string, any> = {
        lastUpdated: FieldValue.serverTimestamp(),
    };

    // Remove user from every slot and unavailable entry
    for (const [slotId, users] of Object.entries(data.slots || {})) {
        if ((users as string[]).includes(user.uid)) {
            updateData[`slots.${slotId}`] = FieldValue.arrayRemove(user.uid);
        }
    }
    for (const [slotId, users] of Object.entries(data.unavailable || {})) {
        if ((users as string[]).includes(user.uid)) {
            updateData[`unavailable.${slotId}`] = FieldValue.arrayRemove(user.uid);
        }
    }

    if (Object.keys(updateData).length <= 1) {
        // Only lastUpdated — nothing to clear
        return interaction.reply({
            content: 'You have no availability set this week.',
            flags: MessageFlags.Ephemeral,
        });
    }

    try {
        await docRef.update(updateData);
    } catch (err) {
        return interaction.reply({
            content: 'Failed to clear — try again.',
            flags: MessageFlags.Ephemeral,
        });
    }

    await interaction.reply({
        content: `✓ Cleared all your availability for Week ${weekId.split('-')[1]}.`,
        flags: MessageFlags.Ephemeral,
    });
}
```

---

### 4. Error Helpers

```typescript
async function replyNotLinked(interaction: any, teamId: string) {
    // Try to determine: is user not linked, or not on team?
    const db = getDb();
    const snap = await db.collection('users')
        .where('discordUserId', '==', interaction.user.id)
        .limit(1)
        .get();

    if (snap.empty) {
        await interaction.reply({
            content: 'Link your Discord account at **matchscheduler.web.app** first.',
            flags: MessageFlags.Ephemeral,
        });
    } else {
        const teamDoc = await db.collection('teams').doc(teamId).get();
        const teamName = teamDoc.exists ? teamDoc.data()?.teamName : teamId;
        await interaction.reply({
            content: `You're not a member of **${teamName}** on MatchScheduler.`,
            flags: MessageFlags.Ephemeral,
        });
    }
}
```

---

### 5. Update `message.ts` — Add action rows to persistent message

When posting/editing the persistent message, include two action rows:

```typescript
const clearButton = new ButtonBuilder()
    .setCustomId(`avail:clearWeek:${teamId}`)
    .setLabel('−Me This Week')
    .setStyle(ButtonStyle.Secondary);

const daySelect = buildDaySelectMenu(`avail:editDay:${teamId}`, teamId);

const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(clearButton);
const row2 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(daySelect);

// Include in message send/edit:
{ embeds: [embed], files: [attachment], components: [row1, row2] }
```

**`buildDaySelectMenu()`** — Creates the day picker with current availability summaries:
```typescript
function buildDaySelectMenu(customId: string, teamId: string): StringSelectMenuBuilder {
    const weekId = getCurrentWeekId();
    const weekDates = getWeekDates(weekId);

    const options = weekDates.map(({ day, date, month }) => {
        const isPast = isDayPast(day, weekId);
        const label = `${capitalize(day)} ${date}${ordinal(date)}${isPast ? ' (past)' : ''}`;
        // Could add user's current slots as description, but requires knowing the user
        // Since this is on the persistent message (visible to all), omit per-user info here
        return { label, value: day };
    });

    return new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder('📅 Edit day...')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(options);
}
```

Note: The day select on the persistent message can't show per-user availability (it's visible to everyone). The per-user summary appears in the ephemeral time slot picker (step 2).

---

### 6. Helper: Get current user slots for a day

```typescript
function getCurrentUserSlots(teamId: string, uid: string, cetDay: string): string[] {
    const state = activeTeams.get(teamId);
    if (!state?.lastAvailability) return [];

    const CET_TIMES = ['1900','1930','2000','2030','2100','2130','2200','2230','2300'];
    return CET_TIMES.filter(cetTime => {
        const utcSlotId = cetToUtcSlotId(cetDay, cetTime);
        return (state.lastAvailability!.slots[utcSlotId] || []).includes(uid);
    });
}
```

This reads from the cached availability data in the listener state — no extra Firestore read needed.

---

## Verification

1. **Edit day flow**:
   - Click "Edit day" dropdown → pick a future day
   - See ephemeral with time slots, current slots pre-checked
   - Toggle some on/off → close dropdown
   - Ephemeral shows diff ("Added: 21:30, 22:00 / Removed: 20:00")
   - Grid image updates for everyone within ~5 seconds
   - Check MatchScheduler website → same changes reflected

2. **No-op protection**:
   - Open time slots, close without changing → "No changes made"
   - No Firestore write occurs

3. **Clear week**:
   - Click "−Me This Week" → ephemeral confirms
   - Grid shows user removed from all slots
   - Website reflects the same

4. **Error cases**:
   - Test with Discord user NOT linked to MatchScheduler → "Link your Discord" message
   - Test with Discord user linked but NOT on this team → "Not a member" message
   - Select a past day → "This day has already passed"

5. **Bidirectional sync**:
   - Add slots on Discord → appears on website
   - Add slots on website → grid updates in Discord
   - Both happen within seconds
