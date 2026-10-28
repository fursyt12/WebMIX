/******************************************************************************
    Copyright (C) 2025 WebMIX contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 2 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
******************************************************************************/

#include "WebMixPluginUi.hpp"

#include "WebMixControl.hpp"

#include <QAbstractButton>
#include <QAbstractItemModel>
#include <QAbstractItemView>
#include <QAbstractScrollArea>
#include <QAbstractSlider>
#include <QAbstractSpinBox>
#include <QAction>
#include <QApplication>
#include <QBoxLayout>
#include <QBuffer>
#include <QCheckBox>
#include <QComboBox>
#include <QDeadlineTimer>
#include <QDesktopServices>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDir>
#include <QDoubleSpinBox>
#include <QElapsedTimer>
#include <QFocusFrame>
#include <QFormLayout>
#include <QGridLayout>
#include <QGroupBox>
#include <QHash>
#include <QHeaderView>
#include <QIcon>
#include <QItemSelectionModel>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLabel>
#include <QLineEdit>
#include <QListView>
#include <QMainWindow>
#include <QMenu>
#include <QMenuBar>
#include <QPixmap>
#include <QPlainTextEdit>
#include <QPointer>
#include <QProgressBar>
#include <QPushButton>
#include <QRadioButton>
#include <QRegularExpression>
#include <QRubberBand>
#include <QScrollArea>
#include <QScrollBar>
#include <QSet>
#include <QSizeGrip>
#include <QSpinBox>
#include <QSplitter>
#include <QStackedLayout>
#include <QStackedWidget>
#include <QTabWidget>
#include <QTableView>
#include <QTextBlock>
#include <QTextDocument>
#include <QTextEdit>
#include <QTimer>
#include <QToolBox>
#include <QToolButton>
#include <QTreeView>
#include <QUrl>
#include <QWindow>

#include <obs-frontend-api.h>
#include <obs.h>

#include <algorithm>
#include <utility>

/* How a window is described to the page. Every node has `t`, its type; nodes
 * for a widget also have its `id` (what Act() names it by), `disabled: true`
 * and `tip` (the tooltip) when they apply.
 *
 *   box       {dir: "h"|"v", items, buttons?}   a box layout; `buttons` is a
 *                                               QDialogButtonBox
 *   grid      {cells: [{r, c, rs, cs, item}]}   a grid layout
 *   form      {rows: [{label?, field?, span?}]} a form layout
 *   spacer    {grow?}
 *   group     {title, checkable?, checked?, body?}
 *   tabs      {tabs: [{title, disabled?, hidden?}], current, body?}
 *   label     {parts: [{text, href?, bold?}], wrap?, external?, align?}
 *   image     {src, w, h}                       a picture, or a widget only
 *                                               it can draw (`cls`)
 *   check     {text, checked, tristate?, label?} checked is 0/1/2 if tristate;
 *                                               label names a box without text
 *   radio     {text, checked}
 *   button    {text, icon?, iconOnly?, checkable?, checked?, default?,
 *              role?, menu?, menuOnly?}         menu: [{id, text, checkable?,
 *                                               checked?, disabled?, items?}
 *                                               | {sep: true}]
 *   text      {value, placeholder?, password?, readonly?}
 *   textarea  {value, readonly?}
 *   combo     {items, index, editable?, value?}
 *   number    {value, min, max, step, decimals, prefix?, suffix?, special?,
 *              readonly?}
 *   slider    {value, min, max, step, vertical?}
 *   progress  {value, min, max, text?}
 *   list      {columns?, rows: [{r, cells, selected?, check?, disabled?}],
 *              total?, multi?}                  a cell is text or a node
 *   separator {dir}
 *   unsupported {cls}
 */

namespace WebMixPluginUi {

/*! In web mode, receives what is opened with QDesktopServices (see
 *  Mirror::Serve()). A QObject with a slot because that is what Qt calls. */
class UrlCatcher : public QObject {
	Q_OBJECT

public:
	using QObject::QObject;

public slots:
	void Open(const QUrl &url);
};

namespace {

/* A request from the page keeps the capture armed this long: enough for a
 * plugin that opens its window from a timer, short enough that a window
 * something else opens later is left alone. */
constexpr int kArmMs = 1500;
/* How often open windows are compared with what their page last saw. */
constexpr int kPollMs = 250;
/* How long a reply waits for a window to settle: its layouts, the plugin
 * filling it in, a message box the action opened. */
constexpr int kSettleMs = 120;
/* A file dialog's folder or a log view can be any size. */
constexpr int kMaxRows = 300;
constexpr int kMaxItems = 1000;
constexpr qsizetype kMaxText = 64 * 1024;
/* A widget only it can draw is sent as a picture, redrawn at most this often. */
constexpr qint64 kGrabMs = 1000;
constexpr int kMaxGrabPixels = 1200 * 900;

/* The session of windows nobody asked for - a plugin's warning, OBS's own error
 * box: every page shows them. */
const QLatin1String kEveryone("*");
/* At most this many notices are kept for the pages. */
constexpr qsizetype kMaxNotices = 50;

/* Set on a window that has to be on screen in web mode too: WebMIX's own
 * address chooser, asked before there is a web interface to ask in. */
const char *const kOnScreenProperty = "webmixOnScreen";

/* The Tools entries OBS's own .ui file puts there. Everything else in the menu
 * came from a plugin. */
const char *const kBuiltInTools[] = {"autoConfigure", "idianPlayground", "actionOpenPluginManager"};

/*! Text without Qt's keyboard accelerators: "&OK" and "Файл (&F)" are a word,
 *  and "&&" is an ampersand. */
QString Plain(QString text)
{
	static const QRegularExpression accelerator(QStringLiteral("\\s*\\(&\\w\\)"));
	text.remove(accelerator);
	QString out;
	out.reserve(text.size());
	for (qsizetype i = 0; i < text.size(); i++) {
		if (text.at(i) == QLatin1Char('&')) {
			if (++i < text.size()) {
				out += text.at(i);
			}
			continue;
		}
		out += text.at(i);
	}
	return out;
}

QString Title(const QWidget *window)
{
	QString title = window->windowTitle();
	title.replace(QLatin1String("[*]"), window->isWindowModified() ? QStringLiteral("*") : QString());
	return title.trimmed();
}

QJsonObject Node(const char *type)
{
	QJsonObject node;
	node["t"] = QLatin1String(type);
	return node;
}

QJsonObject Failure(const QString &error)
{
	QJsonObject result;
	result["ok"] = false;
	result["error"] = error;
	return result;
}

QString PngUrl(const QImage &image)
{
	QByteArray png;
	QBuffer buffer(&png);
	buffer.open(QIODevice::WriteOnly);
	image.save(&buffer, "PNG");
	return QStringLiteral("data:image/png;base64,") + QString::fromLatin1(png.toBase64());
}

/*! The menu a button opens, and whether clicking it does nothing but that. */
QMenu *MenuOf(QAbstractButton *button, bool *only = nullptr)
{
	if (auto *push = qobject_cast<QPushButton *>(button); push && push->menu()) {
		if (only) {
			*only = true;
		}
		return push->menu();
	}
	if (auto *tool = qobject_cast<QToolButton *>(button)) {
		QMenu *menu = tool->menu();
		if (!menu && tool->defaultAction()) {
			menu = tool->defaultAction()->menu();
		}
		if (menu && only) {
			*only = tool->popupMode() == QToolButton::InstantPopup;
		}
		return menu;
	}
	return nullptr;
}

/* ---- the windows -------------------------------------------------------- */

struct Captured {
	QPointer<QWidget> window;
	int id = 0;
	QString session;
	/* The Tools entry that opened it; -1 for a window another one opened. */
	int tool = -1;
	/* What the window was before, to give it back that way. */
	bool showedWithoutActivating = false;
	bool acceptedFocus = true;
	Qt::WindowModality modality = Qt::NonModal;
	bool modalitySet = false;
	/* The description its page last got. */
	QByteArray sent;
};

struct Picture {
	QElapsedTimer taken;
	QSize size;
	QString url;
};

class Mirror : public QObject {
public:
	static Mirror &Get();

	void Arm(const QString &session, int tool);
	bool Armed() const { return armed && !armedUntil.hasExpired(); }

	int Register(QObject *object);
	QObject *Find(int id) const { return objects.value(id); }

	Captured *Window(int id);
	const Captured *Entry(const QWidget *window) const;
	QList<Captured> &Windows() { return windows; }
	qsizetype Count(const QString &session) const;

	QJsonObject State(const QString &session);
	/*! State(session), and what every page has (`everyone`). */
	QJsonObject Reply(const QString &session);
	/*! Hand `from`'s windows to the page `to`. */
	void Adopt(const QString &from, const QString &to);
	void Stop();

	void StartWebMode();
	void Serve();
	void AddNotice(QJsonObject notice);
	bool Dismiss(int notice);
	/*! What a plugin opened with QDesktopServices, sent to the pages. */
	void OpenUrl(const QUrl &url);

	/* For the describer: pictures and text, cached while they do not change. */
	QString PixmapUrl(const QPixmap &pixmap);
	QString IconUrl(const QIcon &icon);
	QString Grab(QWidget *widget, int id);
	QJsonArray Parts(const QString &text, Qt::TextFormat format);
	QString PlainText(const QString &text);

protected:
	bool eventFilter(QObject *watched, QEvent *event) override;

private:
	explicit Mirror(QObject *parent);

	static bool Capturable(const QWidget *window);
	static bool OnScreen(const QWidget *window);
	static void KeepFromFocus(QWidget *window);
	const Captured *Owner(const QWidget *window) const;
	void Capture(QWidget *window, const QString &session, int tool);
	void AnswerAtStartup(QWidget *window);
	void Release(QWidget *window);
	QJsonObject Describe(Captured &entry);
	QJsonArray OpenIds(const QString &session) const;
	QJsonArray NoticeArray() const;
	void Poll();
	void KeepDialogsInQt(bool keep);
	void Prune();

	QList<Captured> windows;
	QTimer *poll = nullptr;
	bool filtering = false;

	bool armed = false;
	QString armedSession;
	int armedTool = -1;
	QDeadlineTimer armedUntil;

	bool keepingDialogs = false;
	bool nativeDialogsWereOff = false;

	/* Web mode: every window is captured, not only the ones a page asked for;
	 * `serving` once there is a page to show them in. */
	bool webMode = false;
	bool serving = false;
	QObject *urls = nullptr;

	/* What every page is told once (a window answered at start-up...). */
	QList<QJsonObject> notices;
	int nextNotice = 1;

	/* Sessions whose windows opened or closed since the last poll. */
	QSet<QString> dirty;

	QHash<QObject *, int> ids;
	QHash<int, QPointer<QObject>> objects;
	int nextId = 1;

	QHash<qint64, QString> pixmaps;
	QHash<qint64, QString> icons;
	QHash<int, Picture> pictures;
	QHash<QString, QJsonArray> richText;
};

/* ---- describing a window ------------------------------------------------ */

class Describer {
public:
	Describer(Mirror &mirror, QWidget *window) : mirror(mirror), window(window) {}

	QJsonValue Contents(QWidget *widget);

private:
	bool Shown(const QWidget *widget) const { return widget && !widget->isWindow() && widget->isVisibleTo(window); }
	int Id(QObject *object) { return mirror.Register(object); }

	QJsonValue Widget(QWidget *widget);
	QJsonValue Specific(QWidget *widget);
	QJsonValue Layout(QLayout *layout);
	QJsonArray Items(QLayout *layout, bool reversed);
	QJsonValue Item(QLayoutItem *item);
	QJsonValue List(QAbstractItemView *view);
	QJsonValue Picture(QWidget *widget);
	QJsonArray MenuItems(QMenu *menu, int depth = 0);

	Mirror &mirror;
	QWidget *window;
};

/*! A box of its items; nothing if all it has is space, and the item itself
 *  if there is just one. */
QJsonValue Box(const QString &dir, const QJsonArray &items)
{
	const bool content = std::any_of(items.begin(), items.end(), [](const QJsonValue &item) {
		return item.toObject().value("t").toString() != QLatin1String("spacer");
	});
	if (!content) {
		return QJsonValue();
	}
	if (items.size() == 1) {
		return items.first();
	}
	QJsonObject node = Node("box");
	node["dir"] = dir;
	node["items"] = items;
	return node;
}

QJsonValue Describer::Contents(QWidget *widget)
{
	if (auto *main = qobject_cast<QMainWindow *>(widget)) {
		QWidget *central = main->centralWidget();
		return Shown(central) ? Widget(central) : QJsonValue();
	}
	if (QLayout *layout = widget->layout()) {
		return Layout(layout);
	}

	/* Placed by hand: top to bottom, then left to right. */
	QList<QWidget *> children;
	for (QWidget *child : widget->findChildren<QWidget *>(Qt::FindDirectChildrenOnly)) {
		if (Shown(child)) {
			children.append(child);
		}
	}
	std::sort(children.begin(), children.end(), [](const QWidget *a, const QWidget *b) {
		return a->y() != b->y() ? a->y() < b->y() : a->x() < b->x();
	});
	QJsonArray items;
	for (QWidget *child : children) {
		const QJsonValue item = Widget(child);
		if (!item.isNull()) {
			items.append(item);
		}
	}
	return Box(QStringLiteral("v"), items);
}

QJsonValue Describer::Layout(QLayout *layout)
{
	if (auto *form = qobject_cast<QFormLayout *>(layout)) {
		QJsonArray rows;
		for (int row = 0; row < form->rowCount(); row++) {
			QJsonObject entry;
			const QJsonValue span = Item(form->itemAt(row, QFormLayout::SpanningRole));
			if (!span.isNull()) {
				entry["span"] = span;
			} else {
				const QJsonValue label = Item(form->itemAt(row, QFormLayout::LabelRole));
				const QJsonValue field = Item(form->itemAt(row, QFormLayout::FieldRole));
				if (!label.isNull()) {
					entry["label"] = label;
				}
				if (!field.isNull()) {
					entry["field"] = field;
				}
			}
			if (!entry.isEmpty()) {
				rows.append(entry);
			}
		}
		if (rows.isEmpty()) {
			return QJsonValue();
		}
		QJsonObject node = Node("form");
		node["rows"] = rows;
		return node;
	}

	if (auto *grid = qobject_cast<QGridLayout *>(layout)) {
		QJsonArray cells;
		for (int index = 0; index < grid->count(); index++) {
			const QJsonValue item = Item(grid->itemAt(index));
			if (item.isNull() || item.toObject().value("t").toString() == QLatin1String("spacer")) {
				continue;
			}
			int row = 0, column = 0, rowSpan = 1, columnSpan = 1;
			grid->getItemPosition(index, &row, &column, &rowSpan, &columnSpan);
			QJsonObject cell;
			cell["r"] = row;
			cell["c"] = column;
			cell["rs"] = qMax(1, rowSpan);
			cell["cs"] = qMax(1, columnSpan);
			cell["item"] = item;
			cells.append(cell);
		}
		if (cells.isEmpty()) {
			return QJsonValue();
		}
		if (cells.size() == 1) {
			return cells.first().toObject().value("item");
		}
		QJsonObject node = Node("grid");
		node["cells"] = cells;
		return node;
	}

	if (auto *stack = qobject_cast<QStackedLayout *>(layout)) {
		QWidget *current = stack->currentWidget();
		return Shown(current) ? Widget(current) : QJsonValue();
	}

	QString dir = QStringLiteral("v");
	bool reversed = false;
	if (auto *box = qobject_cast<QBoxLayout *>(layout)) {
		const QBoxLayout::Direction direction = box->direction();
		if (direction == QBoxLayout::LeftToRight || direction == QBoxLayout::RightToLeft) {
			dir = QStringLiteral("h");
		}
		reversed = direction == QBoxLayout::RightToLeft || direction == QBoxLayout::BottomToTop;
	}
	return Box(dir, Items(layout, reversed));
}

QJsonArray Describer::Items(QLayout *layout, bool reversed)
{
	QJsonArray items;
	for (int index = 0; index < layout->count(); index++) {
		const QJsonValue item = Item(layout->itemAt(index));
		if (!item.isNull()) {
			if (reversed) {
				items.prepend(item);
			} else {
				items.append(item);
			}
		}
	}
	return items;
}

QJsonValue Describer::Item(QLayoutItem *item)
{
	if (!item) {
		return QJsonValue();
	}
	if (QWidget *widget = item->widget()) {
		return Shown(widget) ? Widget(widget) : QJsonValue();
	}
	if (QLayout *layout = item->layout()) {
		return Layout(layout);
	}
	if (QSpacerItem *spacer = item->spacerItem()) {
		const QSizePolicy policy = spacer->sizePolicy();
		const bool grow = (policy.horizontalPolicy() & QSizePolicy::ExpandFlag) ||
				  (policy.verticalPolicy() & QSizePolicy::ExpandFlag);
		if (!grow && spacer->sizeHint().isEmpty()) {
			return QJsonValue();
		}
		QJsonObject node = Node("spacer");
		if (grow) {
			node["grow"] = true;
		}
		return node;
	}
	return QJsonValue();
}

QJsonValue Describer::Widget(QWidget *widget)
{
	const QJsonValue described = Specific(widget);
	if (!described.isObject()) {
		return described;
	}
	QJsonObject node = described.toObject();
	if (!node.contains("id")) {
		return node; /* a layout, or the one thing in it */
	}
	if (!widget->isEnabled()) {
		node["disabled"] = true;
	}
	if (const QString tip = widget->toolTip(); !tip.isEmpty()) {
		node["tip"] = mirror.PlainText(tip);
	}
	return node;
}

QJsonValue Describer::Specific(QWidget *widget)
{
	/* Parts of other widgets, which those draw themselves. */
	if (qobject_cast<QScrollBar *>(widget) || qobject_cast<QSizeGrip *>(widget) ||
	    qobject_cast<QRubberBand *>(widget) || qobject_cast<QFocusFrame *>(widget) ||
	    qobject_cast<QMenuBar *>(widget) || qobject_cast<QSplitterHandle *>(widget) ||
	    qobject_cast<QHeaderView *>(widget)) {
		return QJsonValue();
	}

	if (auto *buttons = qobject_cast<QDialogButtonBox *>(widget)) {
		QJsonObject node = Node("box");
		node["dir"] = buttons->orientation() == Qt::Horizontal ? QStringLiteral("h") : QStringLiteral("v");
		node["buttons"] = true;
		node["items"] = buttons->layout() ? Items(buttons->layout(), false) : QJsonArray();
		return node;
	}

	if (auto *group = qobject_cast<QGroupBox *>(widget)) {
		QJsonObject node = Node("group");
		node["id"] = Id(widget);
		node["title"] = Plain(group->title());
		if (group->isCheckable()) {
			node["checkable"] = true;
			node["checked"] = group->isChecked();
		}
		if (const QJsonValue body = Contents(widget); !body.isNull()) {
			node["body"] = body;
		}
		return node;
	}

	if (auto *tabs = qobject_cast<QTabWidget *>(widget)) {
		QJsonObject node = Node("tabs");
		node["id"] = Id(widget);
		QJsonArray list;
		for (int index = 0; index < tabs->count(); index++) {
			QJsonObject tab;
			tab["title"] = Plain(tabs->tabText(index));
			if (!tabs->isTabEnabled(index)) {
				tab["disabled"] = true;
			}
			if (!tabs->isTabVisible(index)) {
				tab["hidden"] = true;
			}
			list.append(tab);
		}
		node["tabs"] = list;
		node["current"] = tabs->currentIndex();
		if (QWidget *page = tabs->currentWidget()) {
			if (const QJsonValue body = Contents(page); !body.isNull()) {
				node["body"] = body;
			}
		}
		return node;
	}

	if (auto *toolBox = qobject_cast<QToolBox *>(widget)) {
		QJsonObject node = Node("tabs");
		node["id"] = Id(widget);
		QJsonArray list;
		for (int index = 0; index < toolBox->count(); index++) {
			QJsonObject tab;
			tab["title"] = Plain(toolBox->itemText(index));
			if (!toolBox->isItemEnabled(index)) {
				tab["disabled"] = true;
			}
			list.append(tab);
		}
		node["tabs"] = list;
		node["current"] = toolBox->currentIndex();
		if (QWidget *page = toolBox->currentWidget()) {
			if (const QJsonValue body = Contents(page); !body.isNull()) {
				node["body"] = body;
			}
		}
		return node;
	}

	if (auto *stack = qobject_cast<QStackedWidget *>(widget)) {
		QWidget *current = stack->currentWidget();
		return Shown(current) ? Widget(current) : QJsonValue();
	}

	if (auto *area = qobject_cast<QScrollArea *>(widget)) {
		QWidget *inner = area->widget();
		return Shown(inner) ? Widget(inner) : QJsonValue();
	}

	if (auto *splitter = qobject_cast<QSplitter *>(widget)) {
		QJsonArray items;
		for (int index = 0; index < splitter->count(); index++) {
			QWidget *part = splitter->widget(index);
			if (Shown(part)) {
				if (const QJsonValue item = Widget(part); !item.isNull()) {
					items.append(item);
				}
			}
		}
		return Box(splitter->orientation() == Qt::Horizontal ? QStringLiteral("h") : QStringLiteral("v"),
			   items);
	}

	if (auto *check = qobject_cast<QCheckBox *>(widget)) {
		QJsonObject node = Node("check");
		node["id"] = Id(widget);
		node["text"] = Plain(check->text());
		if (check->isTristate()) {
			node["tristate"] = true;
			node["checked"] = static_cast<int>(check->checkState());
		} else {
			node["checked"] = check->isChecked();
		}
		return node;
	}

	if (auto *radio = qobject_cast<QRadioButton *>(widget)) {
		QJsonObject node = Node("radio");
		node["id"] = Id(widget);
		node["text"] = Plain(radio->text());
		node["checked"] = radio->isChecked();
		return node;
	}

	if (auto *button = qobject_cast<QAbstractButton *>(widget); button && button->isCheckable() &&
								    !qobject_cast<QPushButton *>(button) &&
								    !qobject_cast<QToolButton *>(button)) {
		/* A switch the plugin draws itself (the Plugin Manager's): on or off,
		 * as a check box is, and often named only for screen readers. */
		QJsonObject node = Node("check");
		node["id"] = Id(widget);
		node["text"] = Plain(button->text());
		node["checked"] = button->isChecked();
		const QString name = !button->accessibleDescription().isEmpty() ? button->accessibleDescription()
										: button->accessibleName();
		if (!name.isEmpty()) {
			node["label"] = name;
		}
		return node;
	}

	if (auto *button = qobject_cast<QAbstractButton *>(widget)) {
		QJsonObject node = Node("button");
		node["id"] = Id(widget);
		auto *tool = qobject_cast<QToolButton *>(button);
		QString text = Plain(button->text());
		if (text.isEmpty() && tool && tool->defaultAction()) {
			text = Plain(tool->defaultAction()->text());
		}
		node["text"] = text;
		const bool textOnly = tool && tool->toolButtonStyle() == Qt::ToolButtonTextOnly;
		if (!button->icon().isNull() && !textOnly) {
			node["icon"] = mirror.IconUrl(button->icon());
			if (text.isEmpty() || (tool && tool->toolButtonStyle() == Qt::ToolButtonIconOnly)) {
				node["iconOnly"] = true;
			}
		}
		if (button->isCheckable()) {
			node["checkable"] = true;
			node["checked"] = button->isChecked();
		}
		if (auto *push = qobject_cast<QPushButton *>(button); push && push->isDefault()) {
			node["default"] = true;
		}
		if (auto *box = qobject_cast<QDialogButtonBox *>(button->parentWidget())) {
			switch (box->buttonRole(button)) {
			case QDialogButtonBox::AcceptRole:
			case QDialogButtonBox::YesRole:
				node["role"] = QStringLiteral("accept");
				break;
			case QDialogButtonBox::RejectRole:
			case QDialogButtonBox::NoRole:
				node["role"] = QStringLiteral("reject");
				break;
			case QDialogButtonBox::DestructiveRole:
				node["role"] = QStringLiteral("destructive");
				break;
			case QDialogButtonBox::ApplyRole:
				node["role"] = QStringLiteral("apply");
				break;
			default:
				break;
			}
		}
		bool menuOnly = false;
		if (QMenu *menu = MenuOf(button, &menuOnly)) {
			node["menu"] = MenuItems(menu);
			if (menuOnly) {
				node["menuOnly"] = true;
			}
		}
		return node;
	}

	if (auto *edit = qobject_cast<QLineEdit *>(widget)) {
		QJsonObject node = Node("text");
		node["id"] = Id(widget);
		node["value"] = edit->text();
		if (!edit->placeholderText().isEmpty()) {
			node["placeholder"] = edit->placeholderText();
		}
		if (edit->echoMode() == QLineEdit::Password || edit->echoMode() == QLineEdit::PasswordEchoOnEdit) {
			node["password"] = true;
		}
		if (edit->isReadOnly()) {
			node["readonly"] = true;
		}
		return node;
	}

	if (auto *combo = qobject_cast<QComboBox *>(widget)) {
		QJsonObject node = Node("combo");
		node["id"] = Id(widget);
		QJsonArray items;
		for (int index = 0; index < combo->count() && index < kMaxItems; index++) {
			items.append(combo->itemText(index));
		}
		node["items"] = items;
		node["index"] = combo->currentIndex();
		if (combo->isEditable()) {
			node["editable"] = true;
			node["value"] = combo->currentText();
		}
		return node;
	}

	if (auto *spin = qobject_cast<QSpinBox *>(widget)) {
		QJsonObject node = Node("number");
		node["id"] = Id(widget);
		node["value"] = spin->value();
		node["min"] = spin->minimum();
		node["max"] = spin->maximum();
		node["step"] = spin->singleStep();
		node["decimals"] = 0;
		if (!spin->prefix().isEmpty()) {
			node["prefix"] = spin->prefix();
		}
		if (!spin->suffix().isEmpty()) {
			node["suffix"] = spin->suffix();
		}
		if (!spin->specialValueText().isEmpty()) {
			node["special"] = spin->specialValueText();
		}
		if (spin->isReadOnly()) {
			node["readonly"] = true;
		}
		return node;
	}

	if (auto *spin = qobject_cast<QDoubleSpinBox *>(widget)) {
		QJsonObject node = Node("number");
		node["id"] = Id(widget);
		node["value"] = spin->value();
		node["min"] = spin->minimum();
		node["max"] = spin->maximum();
		node["step"] = spin->singleStep();
		node["decimals"] = spin->decimals();
		if (!spin->prefix().isEmpty()) {
			node["prefix"] = spin->prefix();
		}
		if (!spin->suffix().isEmpty()) {
			node["suffix"] = spin->suffix();
		}
		if (!spin->specialValueText().isEmpty()) {
			node["special"] = spin->specialValueText();
		}
		if (spin->isReadOnly()) {
			node["readonly"] = true;
		}
		return node;
	}

	if (auto *spin = qobject_cast<QAbstractSpinBox *>(widget)) {
		/* Dates and times: shown as the widget formats them. */
		QJsonObject node = Node("text");
		node["id"] = Id(widget);
		node["value"] = spin->text();
		node["readonly"] = true;
		return node;
	}

	if (auto *slider = qobject_cast<QAbstractSlider *>(widget)) {
		QJsonObject node = Node("slider");
		node["id"] = Id(widget);
		node["value"] = slider->value();
		node["min"] = slider->minimum();
		node["max"] = slider->maximum();
		node["step"] = slider->singleStep();
		if (slider->orientation() == Qt::Vertical) {
			node["vertical"] = true;
		}
		return node;
	}

	if (auto *progress = qobject_cast<QProgressBar *>(widget)) {
		QJsonObject node = Node("progress");
		node["id"] = Id(widget);
		node["value"] = progress->value();
		node["min"] = progress->minimum();
		node["max"] = progress->maximum();
		if (progress->isTextVisible() && !progress->text().isEmpty()) {
			node["text"] = progress->text();
		}
		return node;
	}

	if (auto *plain = qobject_cast<QPlainTextEdit *>(widget)) {
		QJsonObject node = Node("textarea");
		node["id"] = Id(widget);
		node["value"] = plain->toPlainText().right(kMaxText);
		if (plain->isReadOnly()) {
			node["readonly"] = true;
		}
		return node;
	}

	if (auto *rich = qobject_cast<QTextEdit *>(widget)) {
		QJsonObject node = Node("textarea");
		node["id"] = Id(widget);
		node["value"] = rich->toPlainText().right(kMaxText);
		if (rich->isReadOnly()) {
			node["readonly"] = true;
		}
		return node;
	}

	if (auto *view = qobject_cast<QAbstractItemView *>(widget)) {
		return List(view);
	}

	if (auto *label = qobject_cast<QLabel *>(widget)) {
		const QPixmap pixmap = label->pixmap();
		if (!pixmap.isNull()) {
			QJsonObject node = Node("image");
			node["id"] = Id(widget);
			node["src"] = mirror.PixmapUrl(pixmap);
			const qreal ratio = pixmap.devicePixelRatio() > 0 ? pixmap.devicePixelRatio() : 1.0;
			node["w"] = qRound(pixmap.width() / ratio);
			node["h"] = qRound(pixmap.height() / ratio);
			return node;
		}
		QString text = label->text();
		if (text.isEmpty()) {
			return QJsonValue();
		}
		const bool rich = label->textFormat() == Qt::RichText ||
				  (label->textFormat() == Qt::AutoText && Qt::mightBeRichText(text));
		/* A label with a buddy shows its shortcut the way a button does. */
		if (label->buddy() && !rich) {
			text = Plain(text);
		}
		QJsonObject node = Node("label");
		node["id"] = Id(widget);
		node["parts"] = mirror.Parts(text, label->textFormat());
		if (label->wordWrap()) {
			node["wrap"] = true;
		}
		if (label->openExternalLinks()) {
			node["external"] = true;
		}
		const Qt::Alignment align = label->alignment();
		if (align & Qt::AlignHCenter) {
			node["align"] = QStringLiteral("center");
		} else if (align & Qt::AlignRight) {
			node["align"] = QStringLiteral("right");
		}
		return node;
	}

	if (auto *frame = qobject_cast<QFrame *>(widget);
	    frame && (frame->frameShape() == QFrame::HLine || frame->frameShape() == QFrame::VLine)) {
		QJsonObject node = Node("separator");
		node["dir"] = frame->frameShape() == QFrame::HLine ? QStringLiteral("h") : QStringLiteral("v");
		return node;
	}

	if (qobject_cast<QAbstractScrollArea *>(widget)) {
		return Picture(widget); /* a graphics view, an MDI area... */
	}

	const bool hasChildren =
		std::any_of(widget->children().begin(), widget->children().end(), [this](QObject *child) {
			return child->isWidgetType() && Shown(static_cast<QWidget *>(child));
		});
	if (widget->layout() || hasChildren || qobject_cast<QMainWindow *>(widget)) {
		return Contents(widget);
	}
	/* An empty container. */
	if (widget->metaObject() == &QWidget::staticMetaObject || widget->metaObject() == &QFrame::staticMetaObject) {
		return QJsonValue();
	}
	/* What is left draws itself: a meter, a colour swatch, a preview... */
	return Picture(widget);
}

QJsonValue Describer::List(QAbstractItemView *view)
{
	QJsonObject node = Node("list");
	node["id"] = Id(view);
	QJsonArray rows;
	QAbstractItemModel *model = view->model();
	if (!model) {
		node["rows"] = rows;
		return node;
	}

	const QModelIndex root = view->rootIndex();
	auto *tree = qobject_cast<QTreeView *>(view);
	auto *table = qobject_cast<QTableView *>(view);
	auto *list = qobject_cast<QListView *>(view);

	QList<int> columns;
	if (list) {
		columns.append(list->modelColumn());
	} else {
		for (int column = 0; column < model->columnCount(root); column++) {
			if ((tree && tree->isColumnHidden(column)) || (table && table->isColumnHidden(column))) {
				continue;
			}
			columns.append(column);
		}
	}
	if (columns.isEmpty()) {
		columns.append(0);
	}

	QHeaderView *header = tree ? tree->header() : table ? table->horizontalHeader() : nullptr;
	if (header && !header->isHidden()) {
		QJsonArray names;
		for (int column : columns) {
			names.append(model->headerData(column, Qt::Horizontal, Qt::DisplayRole).toString());
		}
		node["columns"] = names;
	}

	QItemSelectionModel *selection = view->selectionModel();
	const int total = model->rowCount(root);
	for (int row = 0; row < total && rows.size() < kMaxRows; row++) {
		if ((tree && tree->isRowHidden(row, root)) || (table && table->isRowHidden(row)) ||
		    (list && list->isRowHidden(row))) {
			continue;
		}
		QJsonObject entry;
		entry["r"] = row;
		QJsonArray cells;
		bool selected = false;
		for (int column : columns) {
			const QModelIndex index = model->index(row, column, root);
			selected = selected || (selection && selection->isSelected(index));
			if (QWidget *cell = view->indexWidget(index); Shown(cell)) {
				const QJsonValue item = Widget(cell);
				cells.append(item.isNull() ? QJsonValue(QString()) : item);
				continue;
			}
			cells.append(model->data(index, Qt::DisplayRole).toString());
		}
		entry["cells"] = cells;
		if (selected) {
			entry["selected"] = true;
		}
		const QModelIndex first = model->index(row, columns.first(), root);
		const Qt::ItemFlags flags = model->flags(first);
		/* QListWidgetItem is user-checkable by default; it only has a box once
		 * it has a check state. */
		if (const QVariant state = model->data(first, Qt::CheckStateRole);
		    (flags & Qt::ItemIsUserCheckable) && state.isValid()) {
			entry["check"] = state.toInt();
		}
		if (!(flags & Qt::ItemIsEnabled)) {
			entry["disabled"] = true;
		}
		rows.append(entry);
	}
	node["rows"] = rows;
	if (total > rows.size()) {
		node["total"] = total;
	}
	const QAbstractItemView::SelectionMode mode = view->selectionMode();
	if (mode == QAbstractItemView::MultiSelection || mode == QAbstractItemView::ExtendedSelection) {
		node["multi"] = true;
	}
	return node;
}

QJsonValue Describer::Picture(QWidget *widget)
{
	const QSize size = widget->size();
	QJsonObject node = Node("image");
	node["id"] = Id(widget);
	node["cls"] = QString::fromLatin1(widget->metaObject()->className());
	if (size.isEmpty() || size.width() * size.height() > kMaxGrabPixels) {
		node["t"] = QStringLiteral("unsupported");
		return node;
	}
	node["src"] = mirror.Grab(widget, node["id"].toInt());
	node["w"] = size.width();
	node["h"] = size.height();
	return node;
}

QJsonArray Describer::MenuItems(QMenu *menu, int depth)
{
	QJsonArray items;
	for (QAction *action : menu->actions()) {
		if (!action->isVisible()) {
			continue;
		}
		if (action->isSeparator()) {
			QJsonObject separator;
			separator["sep"] = true;
			items.append(separator);
			continue;
		}
		QJsonObject item;
		item["id"] = Id(action);
		item["text"] = Plain(action->text());
		if (action->isCheckable()) {
			item["checkable"] = true;
			item["checked"] = action->isChecked();
		}
		if (!action->isEnabled()) {
			item["disabled"] = true;
		}
		if (QMenu *submenu = action->menu(); submenu && depth < 3) {
			item["items"] = MenuItems(submenu, depth + 1);
		}
		items.append(item);
	}
	return items;
}

/* ---- the mirror --------------------------------------------------------- */

Mirror &Mirror::Get()
{
	static QPointer<Mirror> instance;
	if (!instance) {
		instance = new Mirror(qApp);
	}
	return *instance;
}

Mirror::Mirror(QObject *parent) : QObject(parent), armedUntil(0)
{
	poll = new QTimer(this);
	poll->setInterval(kPollMs);
	connect(poll, &QTimer::timeout, this, &Mirror::Poll);
}

void Mirror::Arm(const QString &session, int tool)
{
	if (!filtering) {
		qApp->installEventFilter(this);
		filtering = true;
	}
	armed = true;
	armedSession = session;
	armedTool = tool;
	armedUntil = QDeadlineTimer(kArmMs);
	KeepDialogsInQt(true);
	if (!poll->isActive()) {
		poll->start();
	}
}

int Mirror::Register(QObject *object)
{
	const auto known = ids.constFind(object);
	if (known != ids.cend() && objects.value(*known) == object) {
		return *known;
	}
	const int id = nextId++;
	ids.insert(object, id);
	objects.insert(id, object);
	return id;
}

Captured *Mirror::Window(int id)
{
	for (Captured &entry : windows) {
		if (entry.id == id && entry.window) {
			return &entry;
		}
	}
	return nullptr;
}

const Captured *Mirror::Entry(const QWidget *window) const
{
	for (const Captured &entry : windows) {
		if (entry.window == window) {
			return &entry;
		}
	}
	return nullptr;
}

qsizetype Mirror::Count(const QString &session) const
{
	return std::count_if(windows.begin(), windows.end(),
			     [&session](const Captured &entry) { return entry.window && entry.session == session; });
}

QJsonArray Mirror::OpenIds(const QString &session) const
{
	QJsonArray open;
	for (const Captured &entry : windows) {
		if (entry.window && entry.session == session) {
			open.append(entry.id);
		}
	}
	return open;
}

void Mirror::Adopt(const QString &from, const QString &to)
{
	if (from == to) {
		return;
	}
	for (Captured &entry : windows) {
		if (entry.session == from) {
			entry.session = to;
			entry.sent.clear();
		}
	}
	dirty.insert(from);
	dirty.insert(to);
}

bool Mirror::Capturable(const QWidget *window)
{
	switch (window->windowType()) {
	case Qt::Popup:
	case Qt::ToolTip:
	case Qt::SplashScreen:
	case Qt::SubWindow:
	case Qt::ForeignWindow:
		return false;
	default:
		break;
	}
	/* Not a plugin's window, whatever shows it. */
	if (window == static_cast<QWidget *>(obs_frontend_get_main_window())) {
		return false;
	}
	/* Projectors are there to be seen: a scene on a monitor is what someone
	 * asked for. They come up without taking the keyboard (KeepFromFocus). */
	if (OnScreen(window) || window->inherits("OBSProjector")) {
		return false;
	}
	/* Kept off screen already, by whoever is showing it. */
	return !window->testAttribute(Qt::WA_DontShowOnScreen);
}

bool Mirror::OnScreen(const QWidget *window)
{
	return window->property(kOnScreenProperty).toBool();
}

void Mirror::KeepFromFocus(QWidget *window)
{
	/* See Capture(): a window that does not accept focus is never activated,
	 * and on Windows is shown with SW_SHOWNOACTIVATE. */
	if (QWindow *handle = window->windowHandle()) {
		handle->setFlag(Qt::WindowDoesNotAcceptFocus, true);
	}
}

const Captured *Mirror::Owner(const QWidget *window) const
{
	for (const QWidget *parent = window->parentWidget(); parent; parent = parent->window()->parentWidget()) {
		if (const Captured *entry = Entry(parent->window())) {
			return entry;
		}
	}
	return nullptr;
}

bool Mirror::eventFilter(QObject *watched, QEvent *event)
{
	const QEvent::Type type = event->type();
	if ((type != QEvent::Show && type != QEvent::Hide && type != QEvent::WinIdChange) || !watched->isWidgetType()) {
		return false;
	}
	auto *widget = static_cast<QWidget *>(watched);
	if (!widget->isWindow()) {
		return false;
	}
	if (type == QEvent::WinIdChange) {
		/* Web mode: a window that is only ever hidden - the main window above
		 * all - must not take the keyboard either. OBS activates its main
		 * window now and then (loading saved projectors, resetting docks), and
		 * on Windows activating a hidden window still makes it the foreground
		 * one. Done as each native window is made, before anything can. */
		if (webMode && !OnScreen(widget)) {
			KeepFromFocus(widget);
		}
		return false;
	}
	if (type == QEvent::Hide) {
		Release(widget);
		return false;
	}
	/* Only a window being shown, not one on screen already coming back (say,
	 * from being minimized). */
	if (event->spontaneous() || widget->testAttribute(Qt::WA_Mapped) || Entry(widget) || !Capturable(widget)) {
		return false;
	}
	if (Armed()) {
		Capture(widget, armedSession, armedTool);
	} else if (const Captured *owner = Owner(widget)) {
		Capture(widget, owner->session, -1);
	} else if (webMode) {
		/* Nobody asked for it - OBS's own error box, a plugin's warning:
		 * every page shows it. */
		Capture(widget, kEveryone, -1);
	}
	return false;
}

void Mirror::Capture(QWidget *window, const QString &session, int tool)
{
	Captured entry;
	entry.window = window;
	entry.id = Register(window);
	entry.session = session;
	entry.tool = tool;
	entry.showedWithoutActivating = window->testAttribute(Qt::WA_ShowWithoutActivating);
	entry.modality = window->windowModality();
	entry.modalitySet = window->testAttribute(Qt::WA_SetWindowModality);

	/* Not modal while it is here (the page shows it modal). A window nobody
	 * can see must not block input to the ones they can, and Qt cannot keep
	 * its list of modal windows straight for one kept off screen from the
	 * middle of being shown: QDialog decides how to show itself before this
	 * runs and how to hide itself after, so it would be listed when shown and
	 * left on the list when hidden - and once deleted, OBS crashes on exit
	 * walking that list. Taken off before the native window would be listed. */
	if (entry.modality != Qt::NonModal) {
		window->setWindowModality(Qt::NonModal);
	}

	/* Off screen. The window is shown - it gets its show event, lays itself
	 * out, isVisible() is true, a modal one runs its event loop - but its
	 * native window is never mapped. This runs from the show event, which Qt
	 * sends before it maps the window. */
	window->setAttribute(Qt::WA_DontShowOnScreen, true);
	window->setAttribute(Qt::WA_ShowWithoutActivating, true);

	/* And never activated. Qt has created the native window by now, and a
	 * window that is asked to activate - a dialog focusing its first field
	 * while OBS is the active application, a plugin calling activateWindow()
	 * - goes through QWindow::requestActivate(), which on Windows calls
	 * SetForegroundWindow() whether the window is visible or not: it would
	 * take the keyboard from whatever the person is typing into. A window
	 * that does not accept focus is never asked (requestActivate() returns
	 * before it gets that far), and on Windows it gets WS_EX_NOACTIVATE too. */
	if (QWindow *handle = window->windowHandle()) {
		entry.acceptedFocus = !handle->flags().testFlag(Qt::WindowDoesNotAcceptFocus);
		handle->setFlag(Qt::WindowDoesNotAcceptFocus, true);
	}

	windows.append(entry);
	dirty.insert(session);
	KeepDialogsInQt(true);
	if (!poll->isActive()) {
		poll->start();
	}
	blog(LOG_INFO, "[WebMIX] Showing '%s' (%s) in the browser", qUtf8Printable(Title(window)),
	     window->metaObject()->className());

	if (webMode && !serving && entry.modality != Qt::NonModal) {
		AnswerAtStartup(window);
	}
}

void Mirror::AnswerAtStartup(QWidget *window)
{
	/* Before the web interface is up there is no page to show this in, and a
	 * modal window holds up OBS's start-up until it is answered - which nobody
	 * could. So it is answered no (Cancel, Close: whatever closing it means),
	 * and the pages are told what it said once they connect. A window that
	 * does not hold anything up just waits for them. */
	QStringList lines;
	for (QLabel *label : window->findChildren<QLabel *>()) {
		if (label->isVisibleTo(window) && !label->text().isEmpty()) {
			lines.append(PlainText(label->text()).trimmed());
		}
	}
	lines.removeAll(QString());
	const QString text = lines.join(QStringLiteral("\n\n")).left(4000);

	QJsonObject notice;
	notice["kind"] = QStringLiteral("startup");
	notice["title"] = Title(window);
	notice["text"] = text;
	AddNotice(notice);
	blog(LOG_WARNING, "[WebMIX] '%s' came up while OBS was starting and was answered no: %s",
	     qUtf8Printable(Title(window)), qUtf8Printable(text));

	/* Later, not from inside its show event: it is still being shown. */
	QPointer<QWidget> guard(window);
	QTimer::singleShot(0, this, [guard]() {
		if (!guard) {
			return;
		}
		guard->close();
		/* A message box without a Cancel ignores closing. */
		if (guard && guard->isVisible()) {
			if (auto *dialog = qobject_cast<QDialog *>(guard.data())) {
				dialog->reject();
			}
		}
		if (guard && guard->isVisible()) {
			guard->hide();
		}
	});
}

void Mirror::AddNotice(QJsonObject notice)
{
	notice["id"] = nextNotice++;
	notices.append(notice);
	while (notices.size() > kMaxNotices) {
		notices.removeFirst();
	}
	dirty.insert(kEveryone);
	if (!poll->isActive()) {
		poll->start();
	}
}

bool Mirror::Dismiss(int notice)
{
	const qsizetype before = notices.size();
	notices.erase(
		std::remove_if(notices.begin(), notices.end(),
			       [notice](const QJsonObject &entry) { return entry.value("id").toInt() == notice; }),
		notices.end());
	if (notices.size() == before) {
		return false;
	}
	dirty.insert(kEveryone);
	if (!poll->isActive()) {
		poll->start();
	}
	return true;
}

void Mirror::Release(QWidget *window)
{
	const auto it = std::find_if(windows.begin(), windows.end(),
				     [window](const Captured &entry) { return entry.window == window; });
	if (it == windows.end()) {
		return;
	}
	const Captured entry = *it;
	windows.erase(it);
	dirty.insert(entry.session);

	/* An ordinary window again, should anything show it on the desktop. Qt
	 * has unmapped it by the time the hide event comes. */
	window->setAttribute(Qt::WA_DontShowOnScreen, false);
	window->setAttribute(Qt::WA_ShowWithoutActivating, entry.showedWithoutActivating);

	/* Modal again for whoever shows it next. It is hidden by now, so this no
	 * longer puts it on Qt's list of modal windows. */
	if (entry.modality != Qt::NonModal) {
		window->setWindowModality(entry.modality);
		window->setAttribute(Qt::WA_SetWindowModality, entry.modalitySet);
	}

	/* Focus only once it is gone for good: Qt is still hiding the window, and
	 * moving focus out of it, when this runs - and a window shown again right
	 * away is captured again and has to stay as it is. */
	if (entry.acceptedFocus) {
		QPointer<QWidget> guard(window);
		QTimer::singleShot(0, this, [this, guard]() {
			if (guard && !Entry(guard)) {
				if (QWindow *handle = guard->windowHandle()) {
					handle->setFlag(Qt::WindowDoesNotAcceptFocus, false);
				}
			}
		});
	}
}

QJsonObject Mirror::Describe(Captured &entry)
{
	QWidget *window = entry.window;
	QJsonObject json;
	json["id"] = entry.id;
	json["title"] = Title(window);
	if (entry.modality != Qt::NonModal) {
		json["modal"] = true;
	}
	json["width"] = window->width();
	json["height"] = window->height();
	Describer describer(*this, window);
	const QJsonValue body = describer.Contents(window);
	json["body"] = body.isNull() ? QJsonValue(Node("box")) : body;
	return json;
}

QJsonObject Mirror::State(const QString &session)
{
	QJsonArray open;
	QJsonArray list;
	for (Captured &entry : windows) {
		if (!entry.window || entry.session != session) {
			continue;
		}
		const QJsonObject window = Describe(entry);
		entry.sent = QJsonDocument(window).toJson(QJsonDocument::Compact);
		open.append(entry.id);
		list.append(window);
	}
	QJsonObject state;
	state["ok"] = true;
	state["session"] = session;
	state["open"] = open;
	state["windows"] = list;
	if (session == kEveryone) {
		state["notices"] = NoticeArray();
	}
	return state;
}

QJsonObject Mirror::Reply(const QString &session)
{
	QJsonObject reply = State(session);
	if (session != kEveryone) {
		reply["everyone"] = State(kEveryone);
	}
	return reply;
}

QJsonArray Mirror::NoticeArray() const
{
	QJsonArray list;
	for (const QJsonObject &notice : notices) {
		list.append(notice);
	}
	return list;
}

void Mirror::Poll()
{
	/* Deleted without being hidden first. */
	for (qsizetype index = windows.size() - 1; index >= 0; index--) {
		if (!windows.at(index).window) {
			dirty.insert(windows.at(index).session);
			windows.removeAt(index);
		}
	}

	QHash<QString, QJsonArray> changed;
	for (Captured &entry : windows) {
		/* A plugin setting its window's flags again puts the widget's own back
		 * on the native window, the ability to take focus with them. */
		if (QWindow *handle = entry.window->windowHandle();
		    handle && !handle->flags().testFlag(Qt::WindowDoesNotAcceptFocus)) {
			handle->setFlag(Qt::WindowDoesNotAcceptFocus, true);
		}
		const QJsonObject window = Describe(entry);
		const QByteArray bytes = QJsonDocument(window).toJson(QJsonDocument::Compact);
		if (bytes != entry.sent) {
			entry.sent = bytes;
			changed[entry.session].append(window);
			dirty.insert(entry.session);
		}
	}

	for (const QString &session : std::as_const(dirty)) {
		QJsonObject data;
		data["session"] = session;
		data["open"] = OpenIds(session);
		data["windows"] = changed.value(session);
		if (session == kEveryone) {
			data["notices"] = NoticeArray();
		}
		WebMixControl::Emit(QStringLiteral("WebMixPluginWindowsChanged"), data, WebMixControl::Intent::Ui);
	}
	dirty.clear();

	if (windows.isEmpty() && !Armed()) {
		armed = false;
		poll->stop();
		/* In web mode the capture stays: any window may come up any time. */
		if (!webMode) {
			KeepDialogsInQt(false);
			if (filtering) {
				qApp->removeEventFilter(this);
				filtering = false;
			}
		}
		Prune();
	}
}

void Mirror::StartWebMode()
{
	webMode = true;
	if (!filtering) {
		qApp->installEventFilter(this);
		filtering = true;
	}
	KeepDialogsInQt(true);
	for (QWidget *widget : QApplication::topLevelWidgets()) {
		if (!OnScreen(widget)) {
			KeepFromFocus(widget);
		}
	}
	blog(LOG_INFO, "[WebMIX] Windows are kept off screen and away from the keyboard; they show in the browser");
}

void Mirror::Serve()
{
	serving = true;
	/* What plugins open with QDesktopServices - a help link, a folder - would
	 * open a browser or a file manager on this computer. It goes to the pages
	 * instead. Only now: OBS opens the web interface itself before this. */
	if (!urls) {
		urls = new UrlCatcher(this);
		for (const char *scheme : {"http", "https", "mailto", "file"}) {
			QDesktopServices::setUrlHandler(QString::fromLatin1(scheme), urls, "Open");
		}
	}
}

void Mirror::OpenUrl(const QUrl &url)
{
	QJsonObject data;
	data["session"] = Armed() ? armedSession : QString(kEveryone);
	if (url.isLocalFile()) {
		data["path"] = QDir::toNativeSeparators(url.toLocalFile());
	} else {
		data["url"] = url.toString(QUrl::FullyEncoded);
	}
	blog(LOG_INFO, "[WebMIX] Sending %s to the browser instead of opening it here", qUtf8Printable(url.toString()));
	WebMixControl::Emit(QStringLiteral("WebMixOpenUrl"), data, WebMixControl::Intent::Ui);
}

void Mirror::KeepDialogsInQt(bool keep)
{
	/* A file dialog a mirrored window opens has to be one of Qt's: the
	 * system's own is a window of another kind, on screen and in front, that
	 * the page can neither see nor answer. */
	if (keep == keepingDialogs) {
		return;
	}
	if (keep) {
		nativeDialogsWereOff = QCoreApplication::testAttribute(Qt::AA_DontUseNativeDialogs);
		QCoreApplication::setAttribute(Qt::AA_DontUseNativeDialogs, true);
	} else {
		QCoreApplication::setAttribute(Qt::AA_DontUseNativeDialogs, nativeDialogsWereOff);
	}
	keepingDialogs = keep;
}

void Mirror::Prune()
{
	for (auto it = objects.begin(); it != objects.end();) {
		if (!it.value()) {
			it = objects.erase(it);
		} else {
			++it;
		}
	}
	for (auto it = ids.begin(); it != ids.end();) {
		if (!objects.contains(it.value())) {
			it = ids.erase(it);
		} else {
			++it;
		}
	}
	pictures.clear();
	pixmaps.clear();
	icons.clear();
	richText.clear();
}

void Mirror::Stop()
{
	poll->stop();
	armed = false;
	serving = false;
	if (urls) {
		for (const char *scheme : {"http", "https", "mailto", "file"}) {
			QDesktopServices::unsetUrlHandler(QString::fromLatin1(scheme));
		}
		delete urls;
		urls = nullptr;
	}
	while (!windows.isEmpty()) {
		if (QWidget *window = windows.first().window) {
			Release(window);
		} else {
			windows.removeFirst();
		}
	}
	KeepDialogsInQt(false);
	if (filtering) {
		qApp->removeEventFilter(this);
		filtering = false;
	}
}

QString Mirror::PixmapUrl(const QPixmap &pixmap)
{
	const qint64 key = pixmap.cacheKey();
	if (const auto known = pixmaps.constFind(key); known != pixmaps.cend()) {
		return *known;
	}
	if (pixmaps.size() > 256) {
		pixmaps.clear();
	}
	return *pixmaps.insert(key, PngUrl(pixmap.toImage()));
}

QString Mirror::IconUrl(const QIcon &icon)
{
	const qint64 key = icon.cacheKey();
	if (const auto known = icons.constFind(key); known != icons.cend()) {
		return *known;
	}
	if (icons.size() > 256) {
		icons.clear();
	}
	/* Drawn at twice the size the page shows it, so it stays sharp. */
	return *icons.insert(key, PngUrl(icon.pixmap(QSize(32, 32)).toImage()));
}

QString Mirror::Grab(QWidget *widget, int id)
{
	auto known = pictures.find(id);
	if (known != pictures.end() && known->size == widget->size() && known->taken.isValid() &&
	    known->taken.elapsed() < kGrabMs) {
		return known->url;
	}
	struct Picture picture;
	picture.taken.start();
	picture.size = widget->size();
	picture.url = PngUrl(widget->grab().toImage());
	pictures.insert(id, picture);
	return picture.url;
}

QJsonArray Mirror::Parts(const QString &text, Qt::TextFormat format)
{
	const bool rich = format == Qt::RichText || (format == Qt::AutoText && Qt::mightBeRichText(text));
	if (!rich) {
		QJsonObject part;
		part["text"] = text;
		return QJsonArray{part};
	}
	if (const auto known = richText.constFind(text); known != richText.cend()) {
		return *known;
	}

	/* Rich text as runs of plain text, links and bold kept. */
	QTextDocument document;
	document.setHtml(text);
	QJsonArray parts;
	for (QTextBlock block = document.begin(); block.isValid(); block = block.next()) {
		if (block != document.begin()) {
			QJsonObject newline;
			newline["text"] = QStringLiteral("\n");
			parts.append(newline);
		}
		for (auto it = block.begin(); !it.atEnd(); ++it) {
			const QTextFragment fragment = it.fragment();
			if (!fragment.isValid()) {
				continue;
			}
			const QTextCharFormat charFormat = fragment.charFormat();
			QJsonObject part;
			part["text"] = fragment.text().replace(QChar::LineSeparator, QLatin1Char('\n'));
			if (charFormat.isAnchor() && !charFormat.anchorHref().isEmpty()) {
				part["href"] = charFormat.anchorHref();
			}
			if (charFormat.fontWeight() >= QFont::DemiBold) {
				part["bold"] = true;
			}
			parts.append(part);
		}
	}
	if (richText.size() > 512) {
		richText.clear();
	}
	richText.insert(text, parts);
	return parts;
}

QString Mirror::PlainText(const QString &text)
{
	if (!Qt::mightBeRichText(text)) {
		return text;
	}
	QTextDocument document;
	document.setHtml(text);
	return document.toPlainText();
}

/* ---- doing what a person would ------------------------------------------ */

/*! Whether `object` is part of `window`: a widget in it, an entry of a menu one
 *  of its buttons opens... */
bool Inside(const QObject *object, const QWidget *window)
{
	for (const QObject *parent = object; parent; parent = parent->parent()) {
		if (parent == window) {
			return true;
		}
	}
	return false;
}

bool Usable(const QObject *object)
{
	if (auto *action = qobject_cast<const QAction *>(object)) {
		return action->isEnabled();
	}
	if (object->isWidgetType()) {
		return static_cast<const QWidget *>(object)->isEnabled();
	}
	return false;
}

/*! The row `row` of a view's list, at the column it shows first. */
QModelIndex RowIndex(QAbstractItemView *view, int row)
{
	QAbstractItemModel *model = view->model();
	if (!model) {
		return {};
	}
	int column = 0;
	if (auto *list = qobject_cast<QListView *>(view)) {
		column = list->modelColumn();
	}
	return model->index(row, column, view->rootIndex());
}

/*! A value as a person enters it: the widget changes and says so with every
 *  signal it would give for a person - not only the ones a setter gives. */
void Set(QWidget *widget, const QJsonValue &value)
{
	if (auto *group = qobject_cast<QGroupBox *>(widget)) {
		if (group->isCheckable() && group->isChecked() != value.toBool()) {
			group->setChecked(value.toBool());
			emit group->clicked(group->isChecked());
		}
		return;
	}
	if (auto *check = qobject_cast<QCheckBox *>(widget); check && check->isTristate() && value.isDouble()) {
		const auto target = static_cast<Qt::CheckState>(qBound(0, qRound(value.toDouble()), 2));
		for (int click = 0; click < 3 && check->checkState() != target; click++) {
			check->click();
		}
		return;
	}
	if (auto *radio = qobject_cast<QRadioButton *>(widget)) {
		if (value.toBool() && !radio->isChecked()) {
			radio->click();
		}
		return;
	}
	if (auto *button = qobject_cast<QAbstractButton *>(widget)) {
		if (button->isCheckable() && button->isChecked() != value.toBool()) {
			button->click();
		}
		return;
	}
	if (auto *edit = qobject_cast<QLineEdit *>(widget)) {
		if (edit->isReadOnly()) {
			return;
		}
		const QJsonObject input = value.toObject();
		const QString text = input.value("text").toString();
		if (edit->text() != text) {
			edit->setText(text);
			emit edit->textEdited(text);
		}
		if (edit->hasAcceptableInput()) {
			if (input.value("submit").toBool()) {
				emit edit->returnPressed();
			}
			emit edit->editingFinished();
		}
		return;
	}
	if (auto *plain = qobject_cast<QPlainTextEdit *>(widget)) {
		if (!plain->isReadOnly() && plain->toPlainText() != value.toString()) {
			plain->setPlainText(value.toString());
		}
		return;
	}
	if (auto *rich = qobject_cast<QTextEdit *>(widget)) {
		if (!rich->isReadOnly() && rich->toPlainText() != value.toString()) {
			rich->setPlainText(value.toString());
		}
		return;
	}
	if (auto *combo = qobject_cast<QComboBox *>(widget)) {
		const QJsonObject choice = value.toObject();
		if (choice.contains("text") && combo->isEditable()) {
			const QString text = choice.value("text").toString();
			combo->setEditText(text);
			if (QLineEdit *edit = combo->lineEdit()) {
				emit edit->textEdited(text);
				/* What typing and Enter do: the combo box picks or adds the
				 * entry and reports it activated. */
				emit edit->returnPressed();
				emit edit->editingFinished();
			}
			return;
		}
		const int index = choice.value("index").toInt(-1);
		if (index >= 0 && index < combo->count()) {
			if (combo->currentIndex() != index) {
				combo->setCurrentIndex(index);
			}
			emit combo->activated(index);
			emit combo->textActivated(combo->itemText(index));
		}
		return;
	}
	if (auto *spin = qobject_cast<QSpinBox *>(widget)) {
		if (!spin->isReadOnly()) {
			spin->setValue(qRound(value.toDouble()));
			emit spin->editingFinished();
		}
		return;
	}
	if (auto *spin = qobject_cast<QDoubleSpinBox *>(widget)) {
		if (!spin->isReadOnly()) {
			spin->setValue(value.toDouble());
			emit spin->editingFinished();
		}
		return;
	}
	if (auto *slider = qobject_cast<QAbstractSlider *>(widget)) {
		slider->setValue(qRound(value.toDouble()));
		return;
	}
}

void Perform(QWidget *window, QObject *target, const QString &action, const QJsonValue &value)
{
	if (action == QLatin1String("close")) {
		window->close();
		return;
	}
	if (auto *qaction = qobject_cast<QAction *>(target)) {
		if (action == QLatin1String("trigger")) {
			qaction->trigger();
		}
		return;
	}
	if (!target->isWidgetType()) {
		return;
	}
	auto *widget = static_cast<QWidget *>(target);

	if (action == QLatin1String("set")) {
		Set(widget, value);
	} else if (action == QLatin1String("click")) {
		if (auto *button = qobject_cast<QAbstractButton *>(widget)) {
			/* A button that only opens a menu would put the menu on screen;
			 * the page shows its entries itself. */
			bool menuOnly = false;
			if (MenuOf(button, &menuOnly) && menuOnly) {
				return;
			}
			button->click();
		}
	} else if (action == QLatin1String("menu")) {
		/* About to be shown: plugins that fill a menu as it opens fill it now,
		 * and the reply has the entries. */
		if (auto *button = qobject_cast<QAbstractButton *>(widget)) {
			if (QMenu *menu = MenuOf(button)) {
				emit menu->aboutToShow();
			}
		}
	} else if (action == QLatin1String("tab")) {
		const int index = value.toInt(-1);
		if (auto *tabs = qobject_cast<QTabWidget *>(widget)) {
			if (index >= 0 && index < tabs->count() && tabs->isTabEnabled(index)) {
				tabs->setCurrentIndex(index);
			}
		} else if (auto *toolBox = qobject_cast<QToolBox *>(widget)) {
			if (index >= 0 && index < toolBox->count() && toolBox->isItemEnabled(index)) {
				toolBox->setCurrentIndex(index);
			}
		}
	} else if (action == QLatin1String("link")) {
		if (auto *label = qobject_cast<QLabel *>(widget)) {
			emit label->linkActivated(value.toString());
		}
	} else if (auto *view = qobject_cast<QAbstractItemView *>(widget)) {
		const QJsonObject request = value.toObject();
		const QModelIndex index = RowIndex(view, request.value("row").toInt(-1));
		if (!index.isValid()) {
			return;
		}
		if (action == QLatin1String("select")) {
			QItemSelectionModel *selection = view->selectionModel();
			const QAbstractItemView::SelectionMode mode = view->selectionMode();
			if (request.value("toggle").toBool() && selection &&
			    (mode == QAbstractItemView::MultiSelection ||
			     mode == QAbstractItemView::ExtendedSelection)) {
				selection->select(index, QItemSelectionModel::Toggle | QItemSelectionModel::Rows);
				selection->setCurrentIndex(index, QItemSelectionModel::NoUpdate);
			} else {
				view->setCurrentIndex(index);
			}
			emit view->pressed(index);
			emit view->clicked(index);
		} else if (action == QLatin1String("activate")) {
			view->setCurrentIndex(index);
			emit view->doubleClicked(index);
			emit view->activated(index);
		} else if (action == QLatin1String("check")) {
			if (view->model()->flags(index) & Qt::ItemIsUserCheckable) {
				view->model()->setData(index,
						       request.value("checked").toBool() ? Qt::Checked : Qt::Unchecked,
						       Qt::CheckStateRole);
			}
		}
	}
}

/*! Reply once `session` has a window more than `known`, or after the arming
 *  time when it never gets one. */
void ReplyWhenShown(const QString &session, qsizetype known, Reply reply)
{
	Mirror &mirror = Mirror::Get();
	auto *timer = new QTimer(&mirror);
	timer->setInterval(50);
	QElapsedTimer waited;
	waited.start();
	QObject::connect(timer, &QTimer::timeout, timer, [timer, session, known, reply, waited]() {
		const bool shown = Mirror::Get().Count(session) > known;
		if (!shown && waited.elapsed() < kArmMs) {
			return;
		}
		timer->stop();
		timer->deleteLater();
		QTimer::singleShot(shown ? kSettleMs : 0, &Mirror::Get(), [session, reply, shown]() {
			QJsonObject result = Mirror::Get().Reply(session);
			if (!shown) {
				result["opened"] = false;
			}
			reply(result);
		});
	});
	timer->start();
}

/* ---- the Tools menu ----------------------------------------------------- */

QMenu *ToolsMenu()
{
	auto *main = static_cast<QWidget *>(obs_frontend_get_main_window());
	return main ? main->findChild<QMenu *>(QStringLiteral("menuTools")) : nullptr;
}

QHash<int, QPointer<QAction>> &ToolActions()
{
	static QHash<int, QPointer<QAction>> actions;
	return actions;
}

int ToolId(QAction *action)
{
	static int next = 1;
	bool known = false;
	const int id = action->property("webmixToolId").toInt(&known);
	if (known && id > 0) {
		return id;
	}
	const int assigned = next++;
	action->setProperty("webmixToolId", assigned);
	ToolActions().insert(assigned, action);
	return assigned;
}

bool BuiltIn(const QAction *action)
{
	return std::any_of(std::begin(kBuiltInTools), std::end(kBuiltInTools),
			   [action](const char *name) { return action->objectName() == QLatin1String(name); });
}

/*! What obs-websocket calls its entry, in the language OBS runs in. */
QString WebSocketTitle()
{
	obs_module_t *module = obs_get_module("obs-websocket");
	const char *text = nullptr;
	if (module && obs_module_get_locale_string(module, "OBSWebSocket.Settings.DialogTitle", &text) && text) {
		return QString::fromUtf8(text);
	}
	return QString();
}

QJsonArray ToolItems(const QList<QAction *> &actions, const QString &webSocketTitle)
{
	QJsonArray items;
	for (QAction *action : actions) {
		if (action->isSeparator() || !action->isVisible() || BuiltIn(action)) {
			continue;
		}
		QJsonObject item;
		item["id"] = ToolId(action);
		item["text"] = Plain(action->text());
		item["enabled"] = action->isEnabled();
		item["checkable"] = action->isCheckable();
		item["checked"] = action->isChecked();
		if (QMenu *submenu = action->menu()) {
			item["items"] = ToolItems(submenu->actions(), webSocketTitle);
		} else if (!webSocketTitle.isEmpty() && action->text() == webSocketTitle) {
			item["replacement"] = QStringLiteral("webSocketSettings");
		}
		items.append(item);
	}
	return items;
}

} // namespace

void UrlCatcher::Open(const QUrl &url)
{
	Mirror::Get().OpenUrl(url);
}

QJsonObject Tools()
{
	QJsonObject tools;
	QMenu *menu = ToolsMenu();
	tools["items"] = menu ? ToolItems(menu->actions(), WebSocketTitle()) : QJsonArray();

	/* OBS's own Plugin Manager is a window like the plugins' ones. */
	auto *main = static_cast<QWidget *>(obs_frontend_get_main_window());
	QAction *manager = main ? main->findChild<QAction *>(QStringLiteral("actionOpenPluginManager")) : nullptr;
	tools["pluginManager"] = manager && manager->isVisible() && manager->isEnabled() ? QJsonValue(ToolId(manager))
											 : QJsonValue();
	return tools;
}

QJsonObject Windows(const QString &session)
{
	return Mirror::Get().Reply(session);
}

void Trigger(int id, const QString &session, Reply reply)
{
	if (!ToolActions().contains(id)) {
		Tools(); /* ids are handed out as the menu is listed */
	}
	QAction *action = ToolActions().value(id);
	if (!action || !action->isEnabled() || action->menu()) {
		reply(Failure(QStringLiteral("That Tools menu entry is not available.")));
		return;
	}

	Mirror &mirror = Mirror::Get();
	/* An entry that toggles its window would close it again: the window it
	 * opened is still open, so it goes to this page. */
	for (const Captured &entry : mirror.Windows()) {
		if (entry.tool == id && entry.window && entry.window->isVisible()) {
			if (entry.session != kEveryone) {
				mirror.Adopt(entry.session, session);
			}
			reply(mirror.Reply(session));
			return;
		}
	}

	const qsizetype known = mirror.Count(session);
	mirror.Arm(session, id);
	blog(LOG_INFO, "[WebMIX] Tools > %s, from the browser", qUtf8Printable(Plain(action->text())));
	/* Queued rather than called: a plugin may run its dialog's event loop
	 * right in the handler, and this request still has to be answered. */
	QPointer<QAction> guard(action);
	QTimer::singleShot(0, &mirror, [guard]() {
		if (guard) {
			guard->trigger();
		}
	});
	ReplyWhenShown(session, known, std::move(reply));
}

void Act(const QJsonObject &request, const QString &session, Reply reply)
{
	Mirror &mirror = Mirror::Get();
	const QString action = request.value("action").toString();
	if (action == QLatin1String("dismiss")) {
		/* A notice read in one page is read. */
		mirror.Dismiss(request.value("value").toInt());
		reply(mirror.Reply(session));
		return;
	}

	Captured *entry = mirror.Window(request.value("window").toInt());
	if (!entry) {
		reply(Failure(QStringLiteral("That window is closed.")));
		return;
	}
	QObject *target = entry->window;
	if (!request.value("widget").isNull() && !request.value("widget").isUndefined()) {
		target = mirror.Find(request.value("widget").toInt());
		if (!target || !Inside(target, entry->window)) {
			reply(Failure(QStringLiteral("That control is no longer there.")));
			return;
		}
	}
	if (action != QLatin1String("close") && !Usable(target)) {
		reply(Failure(QStringLiteral("That control is disabled.")));
		return;
	}

	/* A window every page shows stays theirs; one another page opened is
	 * this one's now. */
	if (entry->session != session && entry->session != kEveryone) {
		mirror.Adopt(entry->session, session);
	}
	/* Whatever this opens - a message box, a file dialog - is this page's. */
	mirror.Arm(session, -1);

	/* Queued for the same reason as Trigger(): a click may run a message
	 * box's event loop before it returns. */
	QPointer<QObject> guard(target);
	QPointer<QWidget> window(entry->window);
	const QJsonValue value = request.value("value");
	QTimer::singleShot(0, &mirror, [guard, window, action, value]() {
		if (guard && window) {
			Perform(window, guard, action, value);
		}
	});
	QTimer::singleShot(kSettleMs, &mirror,
			   [session, reply = std::move(reply)]() { reply(Mirror::Get().Reply(session)); });
}

void StartWebMode()
{
	Mirror::Get().StartWebMode();
}

void Serve()
{
	Mirror::Get().Serve();
}

void Notice(const QJsonObject &notice)
{
	Mirror::Get().AddNotice(notice);
}

void Stop()
{
	Mirror::Get().Stop();
}

} // namespace WebMixPluginUi

#include "WebMixPluginUi.moc"
