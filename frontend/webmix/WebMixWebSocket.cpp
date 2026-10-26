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

#include "WebMixWebSocket.hpp"

#include <QApplication>
#include <QBuffer>
#include <QCheckBox>
#include <QDialog>
#include <QDialogButtonBox>
#include <QHideEvent>
#include <QJsonArray>
#include <QLabel>
#include <QLineEdit>
#include <QPixmap>
#include <QPushButton>
#include <QShowEvent>
#include <QSpinBox>
#include <QStyle>
#include <QTableWidget>

#include <obs-frontend-api.h>
#include <obs.h>

namespace WebMixWebSocket {

namespace {

/* The plugin refuses anything shorter, even with authentication off. */
constexpr int kMinPasswordLength = 6;

/*! The plugin's widgets, by the names its .ui file gives them. */
struct Settings {
	QDialog *dialog = nullptr;
	QCheckBox *enabled = nullptr;
	QCheckBox *alerts = nullptr;
	QCheckBox *debug = nullptr;
	QSpinBox *port = nullptr;
	QCheckBox *auth = nullptr;
	QLineEdit *password = nullptr;
	QTableWidget *sessions = nullptr;
	QPushButton *apply = nullptr;

	bool Complete() const
	{
		return dialog && enabled && alerts && debug && port && auth && password && sessions && apply;
	}
};

/*! obs-websocket's settings dialog. The plugin creates it once, as a child of
 *  the main window; it is matched by its widgets as well as its class name,
 *  because "SettingsDialog" is a name any plugin might use. */
Settings FindSettings()
{
	Settings settings;
	auto *main = static_cast<QWidget *>(obs_frontend_get_main_window());
	if (!main) {
		return settings;
	}
	for (QDialog *dialog : main->findChildren<QDialog *>()) {
		if (qstrcmp(dialog->metaObject()->className(), "SettingsDialog") != 0 ||
		    !dialog->findChild<QCheckBox *>(QStringLiteral("enableWebSocketServerCheckBox"))) {
			continue;
		}
		settings.dialog = dialog;
		settings.enabled = dialog->findChild<QCheckBox *>(QStringLiteral("enableWebSocketServerCheckBox"));
		settings.alerts = dialog->findChild<QCheckBox *>(QStringLiteral("enableSystemTrayAlertsCheckBox"));
		settings.debug = dialog->findChild<QCheckBox *>(QStringLiteral("enableDebugLoggingCheckBox"));
		settings.port = dialog->findChild<QSpinBox *>(QStringLiteral("serverPortSpinBox"));
		settings.auth = dialog->findChild<QCheckBox *>(QStringLiteral("enableAuthenticationCheckBox"));
		settings.password = dialog->findChild<QLineEdit *>(QStringLiteral("serverPasswordLineEdit"));
		settings.sessions = dialog->findChild<QTableWidget *>(QStringLiteral("websocketSessionTable"));
		if (auto *buttons = dialog->findChild<QDialogButtonBox *>(QStringLiteral("buttonBox"))) {
			settings.apply = buttons->button(QDialogButtonBox::Apply);
		}
		break;
	}
	return settings;
}

/*! The Connect Info window, which the plugin creates without a parent. */
QDialog *FindConnectInfo()
{
	for (QWidget *widget : QApplication::topLevelWidgets()) {
		auto *dialog = qobject_cast<QDialog *>(widget);
		if (dialog && qstrcmp(dialog->metaObject()->className(), "ConnectInfo") == 0 &&
		    dialog->findChild<QLabel *>(QStringLiteral("qrCodeLabel"))) {
			return dialog;
		}
	}
	return nullptr;
}

/*! While alive, the dialog's widgets hold the plugin's current settings and
 *  sessions. The plugin loads them in its show handler (and starts refreshing
 *  the session table every second); sending that event without showing the
 *  dialog loads them the same way, and the hide event stops the refresh. */
class Loaded {
public:
	explicit Loaded(QDialog *dialog) : dialog(dialog)
	{
		QShowEvent show;
		QCoreApplication::sendEvent(dialog, &show);
	}
	~Loaded()
	{
		if (!dialog->isVisible()) {
			QHideEvent hide;
			QCoreApplication::sendEvent(dialog, &hide);
		}
	}
	Loaded(const Loaded &) = delete;
	Loaded &operator=(const Loaded &) = delete;

private:
	QDialog *dialog;
};

QJsonArray ReadSessions(const Settings &settings)
{
	/* The Identified column shows one of two standard icons, drawn the way the
	 * plugin draws them. */
	const QImage identifiedIcon =
		settings.dialog->style()->standardIcon(QStyle::SP_DialogOkButton).pixmap(QSize(25, 25)).toImage();

	QJsonArray sessions;
	QTableWidget *table = settings.sessions;
	for (int row = 0; row < table->rowCount(); row++) {
		const auto text = [table, row](int column) {
			const QTableWidgetItem *item = table->item(row, column);
			return item ? item->text() : QString();
		};
		const auto *identified = qobject_cast<QLabel *>(table->cellWidget(row, 3));

		QJsonObject session;
		session["address"] = text(0);
		session["duration"] = text(1);
		session["messages"] = text(2);
		session["identified"] = identified && identified->pixmap().toImage() == identifiedIcon;
		sessions.append(session);
	}
	return sessions;
}

QJsonObject ReadConnectInfo()
{
	QJsonObject info;
	QDialog *dialog = FindConnectInfo();
	if (!dialog) {
		return info;
	}

	/* Its show handler works out the address and draws the QR code. */
	QShowEvent show;
	QCoreApplication::sendEvent(dialog, &show);

	const auto field = [dialog](const char *name) {
		const auto *edit = dialog->findChild<QLineEdit *>(QString::fromLatin1(name));
		return edit ? edit->text() : QString();
	};
	const auto *copyPassword = dialog->findChild<QPushButton *>(QStringLiteral("copyServerPasswordButton"));
	const bool passwordAvailable = copyPassword && copyPassword->isEnabled();

	info["address"] = field("serverIpLineEdit");
	info["port"] = field("serverPortLineEdit");
	info["password"] = field("serverPasswordLineEdit");
	info["passwordAvailable"] = passwordAvailable;
	/* The text the QR code encodes, built the way ConnectInfo builds it. */
	QString url = QStringLiteral("obsws://%1:%2").arg(info["address"].toString(), info["port"].toString());
	if (passwordAvailable) {
		url += QLatin1Char('/') + info["password"].toString();
	}
	info["url"] = url;

	if (const auto *qrLabel = dialog->findChild<QLabel *>(QStringLiteral("qrCodeLabel"))) {
		const QPixmap qr = qrLabel->pixmap();
		if (!qr.isNull()) {
			QByteArray png;
			QBuffer buffer(&png);
			buffer.open(QIODevice::WriteOnly);
			qr.save(&buffer, "PNG");
			info["qr"] = QStringLiteral("data:image/png;base64,") + QString::fromLatin1(png.toBase64());
		}
	}
	return info;
}

} // namespace

QJsonObject State(bool connectInfo)
{
	QJsonObject state;
	const Settings settings = FindSettings();
	state["available"] = settings.Complete();
	if (!settings.Complete()) {
		return state;
	}

	Loaded loaded(settings.dialog);
	state["enabled"] = settings.enabled->isChecked();
	state["alerts"] = settings.alerts->isChecked();
	state["debug"] = settings.debug->isChecked();
	state["port"] = settings.port->value();
	state["portMin"] = settings.port->minimum();
	state["portMax"] = settings.port->maximum();
	/* The plugin disables what a command-line override (--websocket_port,
	 * --websocket_password) has fixed for this run. */
	state["portLocked"] = !settings.port->isEnabled();
	state["authRequired"] = settings.auth->isChecked();
	state["password"] = settings.password->text();
	state["passwordLocked"] = !settings.auth->isEnabled();
	state["minPasswordLength"] = kMinPasswordLength;
	/* Connect Info asks before showing anything while an output is active. */
	state["videoActive"] = obs_video_active();
	state["sessions"] = ReadSessions(settings);
	if (connectInfo) {
		state["connect"] = ReadConnectInfo();
	}
	return state;
}

bool Apply(const QJsonObject &request, QString &error)
{
	const Settings settings = FindSettings();
	if (!settings.Complete()) {
		error = QStringLiteral("obs-websocket is not loaded");
		return false;
	}

	Loaded loaded(settings.dialog);

	if (request.contains("port") && settings.port->isEnabled()) {
		const int port = request["port"].toInt();
		if (port < settings.port->minimum() || port > settings.port->maximum()) {
			error = QStringLiteral("The port must be between %1 and %2.")
					.arg(settings.port->minimum())
					.arg(settings.port->maximum());
			return false;
		}
		settings.port->setValue(port);
	}
	if (settings.auth->isEnabled()) {
		if (request.contains("authRequired")) {
			settings.auth->setChecked(request["authRequired"].toBool());
		}
		if (request.contains("password")) {
			settings.password->setText(request["password"].toString());
		}
	}
	/* The plugin answers a short password with a modal message box. In web
	 * mode nobody would see it, and this request would wait on it forever. */
	if (settings.password->text().size() < kMinPasswordLength) {
		error = QStringLiteral("The password must be at least %1 characters long.").arg(kMinPasswordLength);
		return false;
	}
	if (request.contains("enabled")) {
		settings.enabled->setChecked(request["enabled"].toBool());
	}
	if (request.contains("alerts")) {
		settings.alerts->setChecked(request["alerts"].toBool());
	}
	if (request.contains("debug")) {
		settings.debug->setChecked(request["debug"].toBool());
	}

	/* The password was set programmatically, which the plugin does not count
	 * as a manual edit, so it saves without its "use your own password?"
	 * question; everything else - saving config.json, restarting the server
	 * when the port, password or state changed - is its own Apply. */
	settings.apply->click();

	blog(LOG_INFO, "[WebMIX] obs-websocket settings applied from the web interface (server %s, port %d)",
	     settings.enabled->isChecked() ? "on" : "off", settings.port->value());
	return true;
}

bool Kick(const QString &address, QString &error)
{
	const Settings settings = FindSettings();
	if (!settings.Complete()) {
		error = QStringLiteral("obs-websocket is not loaded");
		return false;
	}

	Loaded loaded(settings.dialog);
	QTableWidget *table = settings.sessions;
	for (int row = 0; row < table->rowCount(); row++) {
		const QTableWidgetItem *item = table->item(row, 0);
		if (!item || item->text() != address) {
			continue;
		}
		QWidget *cell = table->cellWidget(row, 4);
		auto *kick = cell ? cell->findChild<QPushButton *>() : nullptr;
		if (!kick) {
			break;
		}
		kick->click();
		blog(LOG_INFO, "[WebMIX] obs-websocket session %s disconnected from the web interface",
		     qUtf8Printable(address));
		return true;
	}
	error = QStringLiteral("No session is connected from %1").arg(address);
	return false;
}

} // namespace WebMixWebSocket
